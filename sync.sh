#!/usr/bin/env bash
# 用法：改完 shared/app.js 或 shared/style.css 之後，執行這個腳本，
# 兩邊 (pwa/、extension/) 就會自動更新成最新版本，不需要手動複製貼上。
set -euo pipefail
cd "$(dirname "$0")"

cp shared/app.js pwa/app.js
cp shared/style.css pwa/style.css
cp shared/position.html pwa/position.html
cp shared/position.js pwa/position.js
cp shared/config.js pwa/config.js
cp shared/logo.svg pwa/logo.svg
cp shared/app.js extension/app.js
cp shared/style.css extension/style.css
cp shared/position.html extension/position.html
cp shared/position.js extension/position.js
cp shared/config.js extension/config.js
cp shared/logo.svg extension/logo.svg

echo "已同步 shared/app.js、shared/style.css、shared/position.html、shared/position.js、shared/config.js、shared/logo.svg 到 pwa/ 與 extension/"
