# Music

A web archive of ripped CDs with a browser player and user login. Sister
project of [gallery](https://github.com/mitrenga/gallery) — same stack
(nginx + PHP-FPM, no database, everything is read from disk) and an identical
authentication model: `config.json` from the gallery can be copied 1:1.

## Features

- **Album overview** — cover (or a generated placeholder), artist, year,
  track count and length; one fast server request, sorted artist → year
- **Album view** — cover, tags, track list with numbers and durations, disc
  headers for multi-disc sets, per-track artist on compilations; click a
  track to play it, the rest of the album queues up
- **Player bar** — stays visible while browsing: cover (click → album),
  ⏮ ▶ ⏭, seek slider with time, quality switch, volume (remembered);
  ⏮ restarts the track or, within its first 3 s, goes back like a CD player
- **Quality switch** — ALAC original (Safari only) / FLAC lossless / AAC
  256 kb/s; remembered in the browser, switching keeps the position
- **Gapless playback** — the next track is preloaded and started at the exact
  end of the current one, so *Tubular Bells*-style transitions are seamless
- **Keyboard** — Space play/pause, ←/→ previous/next track, Esc closes a
  dialog or returns to the overview
- **Lock screen / headset** — Media Session API: title, artist, cover and
  transport controls on the phone's lock screen
- **Covers** — `cover.jpg` in the album directory, or pick one from the Cover
  Art Archive with a preview and explicit confirmation (`cover` right)
- **Formats** — CDs ripped as ALAC are converted in the background to FLAC and
  AAC copies; tracks still converting are marked ⏳ and start when ready
- **Login** — identical to the gallery: allowed IPs sign in automatically,
  everyone else with username + password (reset by e-mail); `config.json`
  is interchangeable between the two applications
- **Fullscreen** — ⛶ button in the bottom right corner

## Layout

```
music/                 application root (webroot subdirectory /music/)
├── index.php          application page (SPA)
├── app.js             browser logic
├── style.css          styling
├── getData.php        API (login, album list, album tracks)
├── auth.php           verification endpoint for nginx auth_request
├── authLib.php        shared authentication logic (session, IPs, users)
├── transcode.sh       derives FLAC and AAC copies of the ALAC masters (cd/flac, cd/aac)
├── fix-perms.sh       creates cd/ and covers/ and sets ownership and permissions
├── check.sh           security / functionality checklist (curl)
├── config.json        users and allowed IPs (MUST NOT be committed to git!)
├── cd/                the archive – not in git
│   ├── alac/<Artist>/<Album>/*.m4a   masters ripped by Apple Music (+ cover.jpg, .title, .meta.json)
│   ├── flac/<Artist>/<Album>/*.flac  derived lossless copies (reproducible)
│   └── aac/<Artist>/<Album>/*.m4a    derived AAC 256 kb/s copies (reproducible)
└── covers/            generated 400×400 cover thumbnails (reproducible, not in git)
```

## Requirements

nginx + PHP-FPM (PHP 8.1+), ffmpeg/ffprobe for reading tags and transcoding,
ImageMagick (`convert`) for cover thumbnails.

## Gapless playback

Two `<audio>` elements alternate: while a track plays, the next one is
preloaded into the idle element and started `GAPLESS_LEAD_MS` (50 ms, a
constant at the top of the player code in `app.js`) before the current file
runs out — the slight overlap hides the click some browsers produce when the
switch lands exactly on the boundary. Album transitions such as *Tubular
Bells* are therefore seamless; the pause between ordinary tracks is whatever was
ripped from the CD (the silence is part of the audio). FLAC is inherently
gapless; the AAC copies carry ffmpeg's gapless (priming/padding) metadata.

## Formats — why cd/flac and cd/aac exist

CDs ripped with Apple Music are **Apple Lossless (ALAC)**, which only Safari
can decode. The masters in `cd/alac/` are never modified; `transcode.sh`
derives two browser-playable copies with the same `<Artist>/<Album>/<track>`
structure (tags are copied by ffmpeg):

- `cd/flac/` — FLAC, lossless, about the size of the master; plays in Chrome,
  Firefox, Edge and Safari (11+)
- `cd/aac/` — AAC 256 kb/s, a third of the size, for mobile data

The player has a quality switch (ALAC original / FLAC / AAC, default AAC)
remembered in the browser's localStorage — the ALAC option appears only in
browsers that can decode it (Safari); switching keeps the position in the running track.
Conversion starts automatically in the background the first time an album is
opened (FLAC ~1 s, AAC ~10 s per track); tracks whose copy in the chosen
format is not ready yet are greyed out with ⏳, the list refreshes itself and
the player waits for the file. To pre-convert the whole archive run
`./transcode.sh` (do it after adding CDs). Everything under `cd/` is served
statically by nginx (seeking works, no CPU per play) behind `auth_request`.

## Configuration — config.json

```bash
cp config.json.sample config.json     # or copy config.json from the gallery
```

Same keys and semantics as the gallery: `title`, `users` (`user`, `password`,
`email`, `rights`), `smtp` (password-reset mails, PHP `mail()` fallback),
`autoLoginIps` (single IPs or CIDR, optionally `{ "ip": ..., "rights": [...] }`).
The config is read on every request; without the file authentication is
disabled (safeguard). Password reset rewrites the file, so it must be
writable by the web server (`fix-perms.sh` handles it). The only write right is
`cover` — saving album covers (see below); users without it can only listen.

## Covers

An album's cover is `cover.jpg` (or `cover.png`, `folder.jpg`, …) in its
`cd/alac/<Artist>/<Album>/` directory — drop one in by hand, or use the
**Find cover…** button in the album view (needs the `cover` right): it looks the
album up in MusicBrainz, shows the front images the Cover Art Archive has for
the matching releases, and only after you pick one and confirm does the server
download it, save it as `cover.jpg` (JPEG, max 1200 px) and refresh the
400×400 thumbnail in `covers/<Artist>/<Album>.jpg`. The query can be adjusted
when the tags do not match. Without a cover a coloured placeholder with the
artist and title is shown. Covers also appear on the lock screen / in
headset controls through the Media Session API.

## API (getData.php)

| Action | Description |
|---|---|
| `?action=whoami` | login state (IP auto-login happens here) |
| `?action=login` | POST `{user, password}` |
| `?action=logout` | destroy the session |
| `?action=resetRequest` | POST `{email}` → e-mails a password-reset link |
| `?action=resetPassword` | POST `{token, password}` |
| `?action=albums` | album list: `id` (Artist/Album), `artist`, `title`, `year`, `genre`, `tracks`, `duration`, `cover` (original), `thumb` (400×400) |
| `?action=album&id=Artist/Album` | album metadata + tracks: `no`, `disc`, `title`, `artist`, `composer`, `duration`, `codec`, `src` (ALAC master), `formats: {alac, flac, aac}` (URLs; `alac` is the master, the others `null` while being derived); `converting: true` while a conversion runs; `cover`, `thumb` |
| `?action=coverSearch&id=X[&artist=&title=]` | cover candidates from MusicBrainz (release id, title, artist, date, country, format, track count, preview/large image URLs on the Cover Art Archive); nothing is saved |
| `?action=coverSave&id=X` | POST `{mbid}` → downloads the release's front cover as `cover.jpg` (JPEG, max 1200 px) and regenerates the thumbnail (needs the `cover` right, HTTP 403 otherwise) |

Data actions require authentication (HTTP 401); `coverSave` additionally the `cover` right (HTTP 403). Responses are `Cache-Control: no-store`.

Tags are read with `ffprobe` and cached in `.meta.json` inside each album
directory (rebuilt when a track is newer than the cache or the file list
changes). Album title/artist come from the tags (most common value across
tracks), a `.title` file overrides the title; without tags the `NN Title.ext`
file name and the directory names are used. Tracks are ordered by disc and
track number.

## nginx security — IMPORTANT

Like the gallery, the application relies on nginx rules. **Without them,
passwords and audio files are publicly accessible!**

### 1. Deny downloading config.json

```nginx
location ~ /config\.json$ { deny all; }
```

(already present in server blocks that host the gallery)

### 2. Protecting audio files and covers (auth_request)

Everything under `cd/` (all formats) and `covers/` is served directly by nginx —
but a subrequest first verifies the session against `auth.php`. Snippet
`/etc/nginx/snippets/music-auth.conf`:

```nginx
location ~ ^/music/(?:cd|covers)/ {
	auth_request /music-auth-check;
}

location = /music-auth-check {
	internal;
	include fastcgi_params;
	fastcgi_pass unix:/run/php/php-fpm.sock;
	fastcgi_param SCRIPT_FILENAME /home/libmit/sw/music/auth.php;
	fastcgi_pass_request_body off;
	fastcgi_param CONTENT_LENGTH "";
}
```

Each server block then needs:

```nginx
include snippets/music-auth.conf;
```

then `sudo nginx -t && sudo systemctl reload nginx`. When the application does
not live in a `/music` subdirectory, adjust the regex and `SCRIPT_FILENAME`.

### 3. Filesystem permissions — fix-perms.sh

PHP-FPM runs as `www-data` and needs **write** access to `cd/` (derived
flac/aac copies, `.meta.json`, `cover.jpg`), `covers/` and `config.json`
(password reset). `fix-perms.sh` sets directories to `OWNER:www-data` 2770 and
files to 660 — run it again after adding CDs by hand:

```bash
sudo ./fix-perms.sh
```

### 4. Checklist

```bash
./check.sh http://localhost/music [user password]
```

Expected: config.json **403**, API **401** (200 from an auto-login IP), audio
**403**, index and app.js **200**; with credentials everything **200**.

## License

[CC BY-NC-SA 4.0](LICENSE) — Attribution – NonCommercial – ShareAlike.
