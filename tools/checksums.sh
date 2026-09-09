#!/usr/bin/env bash
# Regenerates SHA256SUMS.txt for the tracked source files.
#
# A checksum manifest that no longer matches is worse than none at all — it
# makes an unverified tree look verified. Run this as part of cutting a release,
# and verify with:  shasum -a 256 -c SHA256SUMS.txt
set -euo pipefail
cd "$(dirname "$0")/.."

{
  find . \
    -type f \
    \( -name '*.gs' -o -name '*.js' -o -name '*.html' -o -name '*.toml' \
       -o -name '*.json' -o -name '*.md' -o -name '_headers' \) \
    -not -path './.git/*' \
    -not -path './node_modules/*' \
    -not -name 'SHA256SUMS.txt' \
  | sed 's|^\./||' | LC_ALL=C sort
} | while IFS= read -r f; do
  shasum -a 256 "$f"
done > SHA256SUMS.txt

echo "SHA256SUMS.txt 已更新（$(wc -l < SHA256SUMS.txt | tr -d ' ') 個檔案）"
