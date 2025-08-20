import type { CloudFrontRequestEvent, CloudFrontRequest, CloudFrontResultResponse } from 'aws-lambda'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'

const s3 = new S3Client({
    region: 'ap-northeast-2',
})

type AllowedFmt = 'png' | 'jpg' | 'jpeg' | 'webp' | 'gif'

const ALLOWED_FMTS: AllowedFmt[] = ['png', 'jpg', 'jpeg', 'webp', 'gif']

const toInt = (v?: string, min = 1, max = 8192): number | undefined => {
    if (!v) return undefined

    const n = parseInt(v, 10)
    if (Number.isNaN(n)) return undefined

    return Math.min(Math.max(n, min), max)
}

const contentTypeByExt = (ext: string) => {
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
        default:
            return 'application/octet-stream'
    }
}

export const handler = async (event: CloudFrontRequestEvent): Promise<CloudFrontResultResponse> => {
    const req: CloudFrontRequest = event.Records[0].cf.request
    const uri = req.uri || '/'
    const qs = req.querystring || ''

    const urlQuery = Object.fromEntries(new URLSearchParams(qs))

    const width = toInt(urlQuery['w'])
    const height = toInt(urlQuery['h'])
    const quality = toInt(urlQuery['q'], 1, 100)

    const match = uri.match(/\.([a-zA-Z0-9]+)$/)
    const fileExtensionRaw = (match?.[1] || '').toLowerCase()

    let fileExtension: AllowedFmt | undefined = undefined

    if (ALLOWED_FMTS.includes(fileExtensionRaw as AllowedFmt)) {
        fileExtension = fileExtensionRaw as AllowedFmt
    } else {
        return {
            status: '400',
            statusDescription: 'Bad Request',
            headers: {
                'content-type': [{ value: 'text/plain; charset=utf-8' }],
            },
            body: 'Unsupported or missing image extension.',
        }
    }

    try {
        const obj = await s3.send(
            new GetObjectCommand({
                Bucket: 'cf-image-resize-test-bucket',
                Key: uri.startsWith('/') ? uri.slice(1) : uri,
            })
        )
        const body = await streamToBuffer(obj.Body as any)

        let image = sharp(body, { animated: fileExtension === 'gif' })

        if (width || height) {
            image = image.resize({
                width,
                height,
                fit: 'inside',
                withoutEnlargement: true,
            })
        }

        switch (fileExtension) {
            case 'jpeg':
            case 'jpg': {
                if (quality) image = image.jpeg({ quality })
                else image = image.jpeg()
                break
            }
            case 'png': {
                const compressionLevel =
                    typeof quality === 'number'
                        ? Math.max(0, Math.min(9, Math.round((100 - quality) / 11))) // quality 높을수록 압축 낮춤
                        : 6
                image = image.png({ compressionLevel })
                break
            }
            case 'webp': {
                if (quality) image = image.webp({ quality })
                else image = image.webp()
                break
            }
            case 'gif': {
                image = image.gif()
                break
            }
        }

        const outBuffer = await image.toBuffer()

        const maxAge = 30 * 24 * 60 * 60
        return {
            status: '200',
            statusDescription: 'OK',
            bodyEncoding: 'base64',
            body: outBuffer.toString('base64'),
            headers: {
                'content-type': [{ value: contentTypeByExt(fileExtension) }],
                'cache-control': [{ value: `public, max-age=${maxAge}, immutable` }],
                vary: [{ value: 'Accept,Accept-Encoding' }],
            },
        }
    } catch (e: any) {
        return {
            status: e?.$metadata?.httpStatusCode === 404 ? '404' : '500',
            statusDescription: e?.$metadata?.httpStatusCode === 404 ? 'Not Found' : 'Server Error',
            headers: {
                'content-type': [{ value: 'text/plain; charset=utf-8' }],
            },
            body: e?.$metadata?.httpStatusCode === 404 ? 'Original image not found' : 'Image processing failed',
        }
    }
}

const streamToBuffer = async (stream: NodeJS.ReadableStream): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
    })
