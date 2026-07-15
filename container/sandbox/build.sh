#!/bin/sh
# Build the DeepThink sandbox container image.
# Usage: ./container/sandbox/build.sh
set -e
cd "$(dirname "$0")"
echo "Building deepthink-sandbox:latest..."
docker build -t deepthink-sandbox:latest .
echo "Done. Verify with: docker images | grep deepthink-sandbox"
