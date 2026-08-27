#!/bin/bash
# Security and functionality checklist – run after every nginx change or deployment.
#   ./check.sh [BASE] [user] [password]      default BASE=http://localhost/music
# Expected: config.json 403, API 401 (or 200 from an auto-login IP), audio 403,
# index 200, app.js 200; with credentials: 200 for API and audio after login.
BASE="${1:-http://localhost/music}"
AUDIO="cd/flac/Genesis/Genesis/01%20Mama.flac"
curl -s -o /dev/null -w "config.json:  %{http_code}  (expect 403)\n" "$BASE/config.json"
curl -s -o /dev/null -w "API:          %{http_code}  (expect 401, 200 from auto-login IP)\n" "$BASE/getData.php?action=albums"
curl -s -o /dev/null -w "audio:        %{http_code}  (expect 403, 200 from auto-login IP)\n" "$BASE/$AUDIO"
curl -s -o /dev/null -w "index:        %{http_code}  (expect 200)\n" "$BASE/"
curl -s -o /dev/null -w "app.js:       %{http_code}  (expect 200)\n" "$BASE/app.js"
if [ -n "${2:-}" ]; then
  C=$(mktemp)
  curl -s -c "$C" -o /dev/null -w "login:        %{http_code}  (expect 200)\n" -X POST \
       -d "{\"user\":\"$2\",\"password\":\"$3\"}" "$BASE/getData.php?action=login"
  curl -s -b "$C" -o /dev/null -w "API (auth):   %{http_code}  (expect 200)\n" "$BASE/getData.php?action=whoami"
  curl -s -b "$C" -o /dev/null -w "audio (auth): %{http_code}  (expect 200)\n" "$BASE/$AUDIO"
  rm -f "$C"
fi
