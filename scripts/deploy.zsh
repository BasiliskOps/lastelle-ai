#!/bin/zsh
# Push site changes to S3 and clear the CloudFront cache.
# Run from anywhere on macOS:  zsh scripts/deploy.zsh
set -euo pipefail

BUCKET="lastelle-ai-site"
SITE_DIR="${0:A:h}/.."
DIST_ID=$(cat "${0:A:h}/.cloudfront-id")

aws s3 sync "$SITE_DIR" "s3://$BUCKET" --delete \
  --exclude ".git/*" --exclude ".github/*" --exclude "scripts/*" \
  --exclude "CNAME" --exclude "README.md" --exclude ".DS_Store"
aws s3 cp "$SITE_DIR/site.webmanifest" "s3://$BUCKET/site.webmanifest" \
  --content-type "application/manifest+json" >/dev/null
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
  --query Invalidation.Id --output text
echo "Deployed."
