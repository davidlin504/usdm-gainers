#!/usr/bin/env bash
# 用法：改完 shared/app.js 或 shared/style.css 之後，執行這個腳本，
# 兩邊 (pwa/、extension/) 就會自動更新成最新版本，不需要手動複製貼上。
set -euo pipefail
cd "$(dirname "$0")"

cp shared/app.js pwa/app.js
cp shared/style.css pwa/style.css
cp shared/app.js extension/app.js
cp shared/style.css extension/style.css

echo "已同步 shared/app.js 與 shared/style.css 到 pwa/ 與 extension/"
