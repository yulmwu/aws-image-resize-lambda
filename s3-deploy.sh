cd dist
zip -r ../dist.zip . ../node_modules
cd ..

aws lambda update-function-code \
    --function-name resize-image \
    --region us-east-1 \
    --zip-file fileb://dist.zip
