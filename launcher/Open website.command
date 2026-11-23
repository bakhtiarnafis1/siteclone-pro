#!/bin/sh
# SiteClone — opens this website copy through a small local server (macOS / Linux).
# macOS: the first time, right-click this file > Open.
cd "$(dirname "$0")" || exit 1
if command -v node >/dev/null 2>&1; then
  exec node "_siteclone/serve.mjs"
elif command -v python3 >/dev/null 2>&1; then
  exec python3 "_siteclone/serve.py"
else
  echo ""
  echo "  To run animations, 3D and other interactive parts, install Node.js (https://nodejs.org)"
  echo "  or Python 3 (https://www.python.org/downloads/), then open this file again."
  echo "  Only want to look at the pages? Open index.html instead."
  echo ""
  read -r _
fi
