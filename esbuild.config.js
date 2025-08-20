const esbuild = require('esbuild')

esbuild
    .build({
        entryPoints: ['./src/index.ts'],
        bundle: true,
        minify: true,
        treeShaking: true,
        platform: 'node',
        target: ['node18'],
        outdir: 'dist',
        sourcemap: false,
        external: ['sharp'],
        tsconfig: './tsconfig.json'
    })
    .catch(() => process.exit(1))
