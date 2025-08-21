const esbuild = require('esbuild')

esbuild
    .build({
        entryPoints: ['./src/index.ts'],
        bundle: false,
        minify: true,
        treeShaking: true,
        platform: 'node',
        target: ['node18'],
        format: 'cjs',
        outdir: 'dist',
        sourcemap: false,
        tsconfig: './tsconfig.json'
    })
    .catch(() => process.exit(1))
