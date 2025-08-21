cd dist
zip -r ../dist.zip . ../node_modules
cd ..

aws s3 cp dist.zip s3://2test0820deploy/

aws lambda update-function-code \
    --function-name resize-image \
    --region us-east-1 \
    --s3-bucket 2test0820deploy \
    --s3-key dist.zip
