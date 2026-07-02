#!/usr/bin/env bash
# Build the alex.personal site.
#
#   index.html  — the hand-authored decoy (a clean Chrome "site can't be reached"
#                 page). This script NEVER touches it. Edit it by hand.
#   app.html    — the Staticrypt-encrypted vault, built from index.source.html using
#                 vault-template.html (the trimmed template with NO decoy inside).
#
# The decoy redirects to app.html only after the secret reveal gesture, so a casual
# "view source" / "inspect element" of the landing page shows nothing but an error page.
#
# Usage:  ./build.sh <staticrypt-password>       (or: STATICRYPT_PW=... ./build.sh)
set -euo pipefail
cd "$(dirname "$0")"

PW="${1:-${STATICRYPT_PW:-}}"
if [ -z "$PW" ]; then
  echo "Usage: ./build.sh <staticrypt-password>   (or export STATICRYPT_PW)" >&2
  exit 1
fi

rm -rf encrypted
npx --yes staticrypt index.source.html -p "$PW" --iterations 600000 \
  --template vault-template.html --template-title 'alexdb.xyz' \
  --template-instructions 'Enter password' --template-placeholder 'password' \
  --template-button 'Continue'
mv encrypted/index.source.html app.html
rmdir encrypted

# Leak check — plaintext secrets must NEVER land in a committed file.
fail=0
for f in app.html index.html; do
  n=$(grep -cE 'Grongqing9171|AlexPC|sk-ant|sb_secret' "$f" || true)
  echo "leak check $f: $n"
  [ "$n" -eq 0 ] || fail=1
done
[ "$fail" -eq 0 ] || { echo "LEAK DETECTED — do not commit." >&2; exit 1; }

echo "Build OK  ·  decoy=index.html  vault=app.html"
