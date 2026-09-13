#!/bin/bash
# 本地构建校验（NAS 上无本地 JDK，安卓/iOS 交给 CI）
set -e
cd $(cd "$(dirname "$0")/.." && pwd)
echo "=== node ==="; node -v
echo "=== vite ==="; ./node_modules/.bin/vite --version
echo "=== bundle ==="
./node_modules/.bin/vite build
echo "=== dist ==="
ls -la dist
du -sh dist
