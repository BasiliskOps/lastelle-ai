#!/bin/zsh
# One-time setup: hosts lastelle.ai on S3 + CloudFront (HTTPS via ACM).
# Run from the repo root on macOS:  zsh scripts/aws-setup.zsh
# Requires: AWS CLI v2, configured with credentials (aws configure).
set -euo pipefail

DOMAIN="lastelle.ai"
BUCKET="lastelle-ai-site"
REGION="us-east-1"   # ACM certs for CloudFront must live in us-east-1
SITE_DIR="${0:A:h}/.."

echo "==> Creating private bucket $BUCKET"
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null

echo "==> Uploading site"
aws s3 sync "$SITE_DIR" "s3://$BUCKET" --delete \
  --exclude ".git/*" --exclude ".github/*" --exclude "scripts/*" \
  --exclude "CNAME" --exclude "README.md" --exclude ".DS_Store"
aws s3 cp "$SITE_DIR/site.webmanifest" "s3://$BUCKET/site.webmanifest" \
  --content-type "application/manifest+json" >/dev/null

echo "==> Requesting TLS certificate"
CERT_ARN=$(aws acm request-certificate --region "$REGION" \
  --domain-name "$DOMAIN" --subject-alternative-names "www.$DOMAIN" \
  --validation-method DNS --query CertificateArn --output text)
sleep 15
echo
echo "Add these CNAME records in Porkbun (Host = the name with '.$DOMAIN.' removed):"
aws acm describe-certificate --region "$REGION" --certificate-arn "$CERT_ARN" \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord.[Name,Value]' --output text
echo
read "?Press Enter once the records are saved in Porkbun... "
echo "==> Waiting for certificate validation (usually a few minutes)"
aws acm wait certificate-validated --region "$REGION" --certificate-arn "$CERT_ARN"

echo "==> Creating CloudFront origin access control"
OAC_ID=$(aws cloudfront create-origin-access-control \
  --origin-access-control-config "Name=$BUCKET-oac,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
  --query OriginAccessControl.Id --output text)

CFG=$(mktemp)
cat > "$CFG" <<EOF
{
  "CallerReference": "lastelle-$(date +%s)",
  "Comment": "$DOMAIN",
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "HttpVersion": "http2and3",
  "Aliases": { "Quantity": 2, "Items": ["$DOMAIN", "www.$DOMAIN"] },
  "Origins": { "Quantity": 1, "Items": [{
    "Id": "s3-$BUCKET",
    "DomainName": "$BUCKET.s3.$REGION.amazonaws.com",
    "S3OriginConfig": { "OriginAccessIdentity": "" },
    "OriginAccessControlId": "$OAC_ID"
  }]},
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-$BUCKET",
    "ViewerProtocolPolicy": "redirect-to-https",
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "Compress": true
  },
  "CustomErrorResponses": { "Quantity": 2, "Items": [
    { "ErrorCode": 403, "ResponsePagePath": "/404.html", "ResponseCode": "404", "ErrorCachingMinTTL": 60 },
    { "ErrorCode": 404, "ResponsePagePath": "/404.html", "ResponseCode": "404", "ErrorCachingMinTTL": 60 }
  ]},
  "ViewerCertificate": {
    "ACMCertificateArn": "$CERT_ARN",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021"
  }
}
EOF

echo "==> Creating CloudFront distribution"
read -r DIST_ID DIST_DOMAIN DIST_ARN <<< $(aws cloudfront create-distribution \
  --distribution-config "file://$CFG" \
  --query 'Distribution.[Id,DomainName,ARN]' --output text)

echo "==> Granting CloudFront read access to the bucket"
POLICY=$(mktemp)
cat > "$POLICY" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::$BUCKET/*",
    "Condition": { "StringEquals": { "AWS:SourceArn": "$DIST_ARN" } }
  }]
}
EOF
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$POLICY"

echo "$DIST_ID" > "${0:A:h}/.cloudfront-id"

echo
echo "Done. Distribution $DIST_ID ($DIST_DOMAIN) takes ~5-10 min to deploy."
echo "In Porkbun DNS for $DOMAIN:"
echo "  1. Delete the old GitHub records: the four A records (185.199.x.x), any AAAA records, and the www CNAME to basiliskops.github.io"
echo "  2. Add ALIAS   host: (blank)   answer: $DIST_DOMAIN"
echo "  3. Add CNAME   host: www       answer: $DIST_DOMAIN"
