#!/bin/bash
# Imports CDs ripped by Apple Music (ALAC) into the FLAC archive:
#   cd/alac/<Artist>/<Album>/*.m4a   ->  cd/flac/<Artist>/<Album>/*.flac
# cover.jpg (and other cover files) and .title are copied along; tags are
# copied by ffmpeg. cd/alac/ is only an inbox: once every track of an album
# has been converted successfully, the ALAC album directory is DELETED so the
# masters do not take up space twice (FLAC is lossless, nothing is lost).
# An album whose conversion failed is kept in cd/alac/ for the next run.
#   ./transcode.sh                          # whole inbox
#   ./transcode.sh "cd/alac/Artist/Album"   # one album
# cd/flac/<Artist>/<Album>/.lock marks an album being converted so parallel
# runs do not start a second conversion.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"

convert_album() {
    local dir="$1"
    local rel="${dir#$ROOT/cd/alac/}"
    local flacDir="$ROOT/cd/flac/$rel"
    mkdir -p "$flacDir" || return
    mkdir "$flacDir/.lock" 2>/dev/null || { echo "busy     $rel"; return; }
    trap 'rmdir "$flacDir/.lock" 2>/dev/null' RETURN
    local f base ok=1 n=0
    for f in "$dir"/*; do
        [ -f "$f" ] || continue
        case "${f,,}" in *.m4a|*.mp3|*.flac|*.ogg|*.opus|*.wav|*.aiff|*.aif) ;; *) continue ;; esac
        n=$((n + 1))
        base="$(basename "${f%.*}")"
        if [ ! -f "$flacDir/$base.flac" ] || [ "$f" -nt "$flacDir/$base.flac" ]; then
            if ffmpeg -y -loglevel error -i "$f" -vn -c:a flac "$flacDir/$base.tmp.flac" \
                  && mv "$flacDir/$base.tmp.flac" "$flacDir/$base.flac"; then
                echo "flac     $rel/$base"
            else rm -f "$flacDir/$base.tmp.flac"; echo "FAILED   $rel/$base"; ok=0; fi
        fi
    done
    [ "$n" -gt 0 ] || { echo "empty    $rel"; return; }
    # cover and title override travel with the album (newer copy wins)
    for f in "$dir"/cover.jpg "$dir"/cover.jpeg "$dir"/cover.png "$dir"/folder.jpg "$dir"/folder.png "$dir"/.title; do
        [ -f "$f" ] && cp -p -u "$f" "$flacDir/"
    done
    if [ "$ok" -eq 1 ]; then
        rm -rf "$dir" && echo "removed  cd/alac/$rel"
        rmdir "$(dirname "$dir")" 2>/dev/null   # artist directory, when it became empty
    else
        echo "kept     cd/alac/$rel (conversion incomplete)"
    fi
}

if [ $# -gt 0 ]; then
    convert_album "$(cd "$1" && pwd)"
else
    for d in "$ROOT"/cd/alac/*/*/; do [ -d "$d" ] && convert_album "${d%/}"; done
fi
exit 0
