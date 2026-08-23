#!/usr/bin/env zsh
set -euo pipefail

cd "$(dirname "$0")"
if [[ ! -x node_modules/.bin/electron ]]; then
  npm install
fi
exec npm start
