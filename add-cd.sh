#!/bin/bash
# Run after copying new CD(s) into cd/alac/<Artist>/<Album>/:
#   1. sudo ./fix-perms.sh        - the web server gets write access (covers, .meta.json)
#   2. ./transcode.sh [album...]  - converts ALAC -> cd/flac and removes the ALAC inbox copy
#   3. sudo ./fix-perms.sh        - the freshly created FLAC files get the right permissions too
# Usage:
#   ./add-cd.sh                             # whole archive
#   ./add-cd.sh "cd/alac/Artist/Album" ...  # only the given album(s)
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "== fix-perms (before)"; sudo "$ROOT/fix-perms.sh" "$ROOT"
echo "== transcode"
if [ $# -eq 0 ]; then "$ROOT/transcode.sh"; else for a in "$@"; do "$ROOT/transcode.sh" "$a"; done; fi
echo "== fix-perms (after)";  sudo "$ROOT/fix-perms.sh" "$ROOT"
echo "done"
