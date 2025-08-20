rm -rf dist node_modules

docker run --rm \
    -v "$PWD":/var/task \
    -w /var/task \
    --entrypoint /bin/bash \
    amazon/aws-lambda-nodejs \
    -lc '
        npm ci
        npm rebuild --platform=linux --arch=x64 sharp
        node esbuild.config.js
    '
