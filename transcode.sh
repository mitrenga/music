#!/bin/bash
# Derives browser-playable copies of the ALAC masters in cd/alac/<Artist>/<Album>/:
#   cd/flac/<Artist>/<Album>/<track>.flac   lossless (FLAC – Chrome, Firefox, Safari)
#   cd/aac/<Artist>/<Album>/<track>.m4a     AAC 256 kb/s (a third of the size, for mobile)
# Masters are never touched; tags are copied by ffmpeg. Only missing or
# outdated copies are (re)made. Called in the background by getData.php when
# an album is opened, or by hand:
#   ./transcode.sh                          # whole archive
#   ./transcode.sh "cd/alac/Artist/Album"   # one album
# cd/aac/<Artist>/<Album>/.lock marks an album being converted so parallel
# requests do not start a second run.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"

convert_album() {
    local dir="$1"
    local rel="${dir#$ROOT/cd/alac/}"
    local flacDir="$ROOT/cd/flac/$rel" aacDir="$ROOT/cd/aac/$rel"
    mkdir -p "$flacDir" "$aacDir" || return
    mkdir "$aacDir/.lock" 2>/dev/null || { echo "busy     $rel"; return; }
    trap 'rmdir "$aacDir/.lock" 2>/dev/null' RETURN
    local f base
    for f in "$dir"/*; do
        [ -f "$f" ] || continue
        case "${f,,}" in *.m4a|*.mp3|*.flac|*.ogg|*.opus|*.wav|*.aiff|*.aif) ;; *) continue ;; esac
        base="$(basename "${f%.*}")"
        if [ ! -f "$flacDir/$base.flac" ] || [ "$f" -nt "$flacDir/$base.flac" ]; then
            if ffmpeg -y -loglevel error -i "$f" -vn -c:a flac "$flacDir/$base.tmp.flac" \
                  && mv "$flacDir/$base.tmp.flac" "$flacDir/$base.flac"; then
                echo "flac     $rel/$base"
            else rm -f "$flacDir/$base.tmp.flac"; echo "FAILED   flac $rel/$base"; fi
        fi
        if [ ! -f "$aacDir/$base.m4a" ] || [ "$f" -nt "$aacDir/$base.m4a" ]; then
            if ffmpeg -y -loglevel error -i "$f" -vn -c:a aac -b:a 256k -movflags +faststart "$aacDir/$base.tmp.m4a" \
                  && mv "$aacDir/$base.tmp.m4a" "$aacDir/$base.m4a"; then
                echo "aac      $rel/$base"
            else rm -f "$aacDir/$base.tmp.m4a"; echo "FAILED   aac $rel/$base"; fi
        fi
    done
}

if [ $# -gt 0 ]; then
    convert_album "$(cd "$1" && pwd)"
else
    for d in "$ROOT"/cd/alac/*/*/; do convert_album "${d%/}"; done
fi
