#!/bin/bash
# Ensure the cd/ and covers/ directories exist and have the ownership
# and permissions the web server needs (PHP-FPM and nginx run as www-data
# and must write covers, .meta.json, cover.jpg and the flac/aac copies, and serve files):
#
#   - directories: PROJECT-OWNER:www-data, 2770 (setgid - new files inherit the group)
#   - files:       PROJECT-OWNER:www-data,  660
#   - config.json: PROJECT-OWNER:www-data,  660 (password reset rewrites it)
#
# Nothing is world-accessible afterwards, so it is stricter than "chmod 777".
# Must run as root (thumbnails are owned by www-data, changing their owner
# needs it):  sudo ./fix-perms.sh [project-directory]   (default: next to the script)
set -eu

WEB_GROUP=www-data
ROOT="$(cd "${1:-$(dirname "$0")}" && pwd)"

# refuse to touch a directory that is not a music project
if [ ! -f "$ROOT/getData.php" ]; then
    echo "not a music project (getData.php missing): $ROOT"; exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
    echo "must run as root:  sudo $0 $ROOT"; exit 1
fi
if ! getent group "$WEB_GROUP" >/dev/null; then
    echo "group not found: $WEB_GROUP"; exit 1
fi

# everything stays owned by the project owner, only the group opens it to the web server
OWNER="$(stat -c %U "$ROOT")"

for dir in cd covers; do
    if [ ! -d "$ROOT/$dir" ]; then
        mkdir "$ROOT/$dir"
        echo "created  $ROOT/$dir"
    fi
    chown -R "$OWNER:$WEB_GROUP" "$ROOT/$dir"
    find "$ROOT/$dir" -type d -exec chmod 2770 {} +
    find "$ROOT/$dir" -type f -exec chmod 660 {} +
    echo "fixed    $ROOT/$dir  ($OWNER:$WEB_GROUP, dirs 2770, files 660)"
done

if [ -f "$ROOT/config.json" ]; then
    chown "$OWNER:$WEB_GROUP" "$ROOT/config.json"
    chmod 660 "$ROOT/config.json"
    echo "fixed    $ROOT/config.json  ($OWNER:$WEB_GROUP, 660)"
fi
