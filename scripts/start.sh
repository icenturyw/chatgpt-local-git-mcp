#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f config.yaml ]; then
  cp config.example.yaml config.yaml
  echo "Created config.yaml from config.example.yaml. Edit repo paths before starting."
  exit 1
fi
npm run build
npm start
