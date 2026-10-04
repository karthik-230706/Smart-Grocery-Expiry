#!/usr/bin/env bash
# Mac/Linux: ./start-smartshelf.sh  — installs deps on first run, then starts the server.
cd "$(dirname "$0")/backend" || exit 1
command -v node >/dev/null || { echo "Install Node.js (LTS) from https://nodejs.org first."; exit 1; }
[ -d node_modules ] || npm install
echo "Open http://localhost:4000 — keep this terminal open."
npm start
