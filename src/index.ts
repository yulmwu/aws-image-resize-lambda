import type { CloudFrontRequestEvent, CloudFrontRequest, CloudFrontResultResponse, CloudFrontHeaders } from 'aws-lambda'
import { S3Client, GetObjectCommand, type GetObjectCommandOutput } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { Readable } from 'stream'
import { ReadableStream as WebReadableStream } from 'stream/web'
import { StreamingBlobPayloadOutputTypes } from '@smithy/types'

type ImageExtension = 'png' | 'jpg' | 'jpeg' | 'webp' | 'gif'
type ParsedParams = {
    width?: number
    height?: number
    quality?: number
    extension?: ImageExtension
}

const REGION = 'ap-northeast-2'
const BUCKET = 'cf-image-resize-test-bucket'
const MAX_BYTES = 1_000_000
const ALLOWED_EXTENSIONS: ImageExtension[] = ['png', 'jpg', 'jpeg', 'webp', 'gif']

class ImageResizeEdge {
    private readonly s3: S3Client

    constructor() {
        this.s3 = new S3Client({ region: REGION })
    }

    async handle(event: CloudFrontRequestEvent): Promise<CloudFrontResultResponse> {
        const request = event.Records[0].cf.request

        const params = this.parseParams(request)
        if (!this.shouldProcess(params)) return this.passThrough(request)

        const key = this.keyFromUri(request.uri)
        if (!key) return this.badRequest('Invalid path.')

        try {
            const s3object = await this.getObject(key)
            if (!s3object.Body) return this.notFound('Image not found')

            if (typeof s3object.ContentLength === 'number' && s3object.ContentLength > 50_000_000) {
                return this.payloadTooLarge('Original image too large.')
            }

            const buffer = await this.bufferFromBody(s3object.Body)
            const output = await this.transform(buffer, params)

            if (output.byteLength > MAX_BYTES) return this.payloadTooLarge('Image exceeds 1MB limit.')

            return this.ok(output, this.contentTypeByExt(params.extension!))
        } catch (e: unknown) {
            const httpCode = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
            if (httpCode === 404) return this.notFound('Original image not found')
            return this.serverError('Image processing failed')
        }
    }

    private parseParams(req: CloudFrontRequest): ParsedParams {
        const query = new URLSearchParams(req.querystring ?? '')

        return {
            width: this.toInt(query.get('w') ?? undefined),
            height: this.toInt(query.get('h') ?? undefined),
            quality: this.toInt(query.get('q') ?? undefined, 1, 100),
            extension: this.extensionFromUri(req.uri),
        }
    }

    private shouldProcess(params: ParsedParams): boolean {
        if (!params.extension || !ALLOWED_EXTENSIONS.includes(params.extension)) return false
        return Boolean(params.width || params.height || params.quality)
    }

    private extensionFromUri(uri: string): ImageExtension | undefined {
        const match = uri.match(/\.([a-zA-Z0-9]+)$/)
        const raw = (match?.[1] || '').toLowerCase()

        return ALLOWED_EXTENSIONS.includes(raw as ImageExtension) ? (raw as ImageExtension) : undefined
    }

    private keyFromUri(uri: string): string | null {
        let key = decodeURIComponent(uri)
        if (key.startsWith('/')) key = key.slice(1)
        if (key.includes('..')) return null
        key = key.replace(/\/{2,}/g, '/')
        return key.length ? key : null
    }

    private async getObject(key: string): Promise<GetObjectCommandOutput> {
        return this.s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    }

    private async transform(input: Buffer, p: ParsedParams): Promise<Buffer> {
        const img = sharp(input, { animated: p.extension === 'gif', limitInputPixels: 100_000_000 })

        const meta = await img.metadata()
        if (meta.format !== p.extension) throw new Error('Mismatched image format')

        let stream = img
        if (p.width || p.height) {
            stream = stream.resize({ width: p.width, height: p.height, fit: 'inside', withoutEnlargement: true })
        }

        switch (p.extension) {
            case 'jpg':
            case 'jpeg':
                stream = p.quality ? stream.jpeg({ quality: p.quality }) : stream.jpeg()
                break
            case 'png':
                stream = stream.png({ compressionLevel: this.pngCompressionLevel(p.quality) })
                break
            case 'webp':
                stream = p.quality ? stream.webp({ quality: p.quality }) : stream.webp()
                break
            case 'gif':
                stream = stream.gif()
                break
        }

        return stream.toBuffer()
    }

    private pngCompressionLevel(quality?: number): number {
        if (typeof quality !== 'number') return 6

        return Math.max(0, Math.min(9, Math.round((100 - quality) / 11)))
    }

    private toInt(value?: string, min = 1, max = 8192): number | undefined {
        if (!value) return undefined

        const parsed = Number.parseInt(value, 10)
        if (Number.isNaN(parsed)) return undefined

        return Math.min(Math.max(parsed, min), max)
    }

    private contentTypeByExt(ext: ImageExtension): string {
        switch (ext) {
            case 'jpg':
            case 'jpeg':
                return 'image/jpeg'
            case 'png':
                return 'image/png'
            case 'webp':
                return 'image/webp'
            case 'gif':
                return 'image/gif'
        }
    }

    private async bufferFromBody(body: StreamingBlobPayloadOutputTypes): Promise<Buffer> {
        if (this.isBlobLike(body)) {
            const ab = await (body as Blob).arrayBuffer()
            return Buffer.from(ab)
        }
        if (this.isWebReadableStream(body)) {
            const nodeReadable = Readable.fromWeb(body as WebReadableStream)
            return this.streamToBuffer(nodeReadable)
        }
        return this.streamToBuffer(body as Readable)
    }

    private isBlobLike(x: unknown): x is Blob {
        return typeof x === 'object' && x !== null && 'arrayBuffer' in (x as Record<string, unknown>)
    }

    private isWebReadableStream(x: unknown): x is WebReadableStream {
        return typeof x === 'object' && x !== null && 'getReader' in (x as Record<string, unknown>)
    }

    private async streamToBuffer(stream: Readable): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = []
            stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as ArrayBufferLike)))
            stream.on('end', () => resolve(Buffer.concat(chunks)))
            stream.on('error', reject)
        })
    }

    private headers(contentType?: string): CloudFrontHeaders {
        const maxAge = 30 * 24 * 60 * 60
        const h: CloudFrontHeaders = {
            'cache-control': [{ value: `public, max-age=${maxAge}, immutable` }],
            vary: [{ value: 'Accept,Accept-Encoding' }],
        }
        if (contentType) h['content-type'] = [{ value: contentType }]
        return h
    }

    private ok(body: Buffer, contentType: string): CloudFrontResultResponse {
        return {
            status: '200',
            statusDescription: 'OK',
            bodyEncoding: 'base64',
            body: body.toString('base64'),
            headers: this.headers(contentType),
        }
    }

    private badRequest(msg: string): CloudFrontResultResponse {
        return {
            status: '400',
            statusDescription: 'Bad Request',
            body: msg,
            headers: this.headers('text/plain; charset=utf-8'),
        }
    }

    private notFound(msg: string): CloudFrontResultResponse {
        return {
            status: '404',
            statusDescription: 'Not Found',
            body: msg,
            headers: this.headers('text/plain; charset=utf-8'),
        }
    }

    private payloadTooLarge(msg: string): CloudFrontResultResponse {
        return {
            status: '413',
            statusDescription: 'Payload Too Large',
            body: msg,
            headers: this.headers('text/plain; charset=utf-8'),
        }
    }

    private serverError(msg: string): CloudFrontResultResponse {
        return {
            status: '500',
            statusDescription: 'Server Error',
            body: msg,
            headers: this.headers('text/plain; charset=utf-8'),
        }
    }

    private passThrough(req: CloudFrontRequest): CloudFrontResultResponse {
        return req as unknown as CloudFrontResultResponse
    }
}

export const handler = async (event: CloudFrontRequestEvent): Promise<CloudFrontResultResponse> => {
    const svc = new ImageResizeEdge()
    return svc.handle(event)
}
