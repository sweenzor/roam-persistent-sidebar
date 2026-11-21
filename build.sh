#!/usr/bin/env bash
# Roam Depot build. The Depot runs this from the repository root, then picks up extension.js,
# README.md and CHANGELOG.md from here.
set -euo pipefail
cd "$(dirname "$0")"
npm ci --no-audit --no-fund
npm run build
cp dist/extension.js extension.js
