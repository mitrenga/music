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
  ⏮ ▶ ⏭, seek slider with time, volume (remembered);
  ⏮ restarts the track or, within its first 3 s, goes back like a CD player
- **Gapless playback** — the next track is preloaded and started at the exact
  end of the current one, so *Tubular Bells*-style transitions are seamless
- **Keyboard** — Space play/pause, ←/→ previous/next track, Esc closes a
  dialog or returns to the overview
- **Lock screen / headset** — Media Session API: title, artist, cover and
  transport controls on the phone's lock screen
- **Covers** — `cover.jpg` in the album directory, or pick one from the Cover
  Art Archive with a preview and explicit confirmation, or upload your own image
  file (JPEG/PNG/GIF/WebP, max 20 MB – raise `upload_max_filesize`,
  `post_max_size` and nginx `client_max_body_size` if needed) (`cover` right)
- **Formats** — the archive is FLAC only (lossless, plays in every current
  browser); CDs ripped as ALAC by Apple Music are imported by `transcode.sh`
- **Download** — a password user can have one album prepared as a ZIP in
  FLAC, ALAC, AAC or MP3 (tags and cover embedded) for an external player;
  conversion runs in the background with progress in the page
- **Login** — identical to the gallery: allowed IPs sign in automatically,
  everyone else with username + password (reset by e-mail); a password login
  is remembered indefinitely by a signed cookie renewed on every visit
  (invalidated by a password change or sign-out); `config.json` is
  interchangeable between the two applications
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
├── downloadLib.php    album download helpers (job.json, names, ZIP writer)
├── download-worker.php background conversion of one album into a ZIP (started by getData.php)
├── nginx/             complete nginx server examples: root.conf (app alone in the web root), subdir.conf (several apps in subdirectories)
├── transcode.sh       imports ALAC rips from cd/alac/ into cd/flac/ (and removes them from the inbox)
├── fix-perms.sh       creates cd/ and covers/ and sets ownership and permissions
├── add-cd.sh          after adding CDs: fix-perms → transcode → fix-perms in one go
├── check.sh           security / functionality checklist (curl)
├── config.json        users and allowed IPs (MUST NOT be committed to git!)
├── cd/                the archive – not in git
│   ├── flac/<Artist>/<Album>/*.flac  the archive (+ cover.jpg, .title, .meta.json)
│   └── alac/<Artist>/<Album>/*.m4a   inbox: rips by Apple Music, deleted after import
├── covers/            generated 400×400 cover thumbnails (reproducible, not in git)
└── tmp/<user>/        one prepared album download per user (job.json + ZIP) – not in git
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
gapless.

## Formats — FLAC archive, ALAC inbox

The archive in `cd/flac/<Artist>/<Album>/*.flac` is the single source of the
album and track lists and the only format the player streams — FLAC is
lossless and plays in Chrome, Firefox, Edge and Safari (11+). CDs ripped with
Apple Music are **Apple Lossless (ALAC)**, which only Safari can decode, so
they are dropped into the inbox `cd/alac/<Artist>/<Album>/` and imported with
`./add-cd.sh` (fix-perms → transcode → fix-perms). `transcode.sh` converts
every track to FLAC (tags copied by ffmpeg, ~1 s per track), copies `cover.jpg`
and `.title` along and then **deletes the ALAC album directory** so the music
is not stored twice; an album whose conversion failed stays in the inbox for
the next run. Everything under `cd/` is served statically by nginx (seeking
works, no CPU per play) behind `auth_request`.

## Album download

Every password user (not IP auto-logins – an IP is not an identity) can have
**one** album prepared for download at a time. **Download…** in the album view
opens a dialog with the format – **FLAC** (the archive files as they are,
ready at once), **ALAC** (Apple Lossless, `.m4a`), **AAC** 256 kb/s (`.m4a`)
or **MP3** V0 (~245 kb/s, ID3v2.3) – an optional *file names without accents*
switch for FAT32 sticks and car radios, and a size estimate. The ZIP is
`Artist - Album (year) [FORMAT].zip` containing
`Artist/Album (year)/01 - Title.ext` plus `cover.jpg`; converted files carry
the tags and an embedded 600 px cover, so any player sorts them properly.

The API writes `tmp/<user>/job.json` and starts `download-worker.php`
detached (`nohup … &`); it converts up to 4 tracks in parallel with ffmpeg,
packs them (own ZIP writer, method *stored* – audio does not compress, no zip
extension needed; 4 GB limit) and reports `queued → converting → packing →
ready | error` back into `job.json`, which the page polls every 2 s. The
finished ZIP is served by nginx from `tmp/` behind `auth_request`; `auth.php`
only lets the owner download it. A second album asks whether to replace the
first; a running preparation can be cancelled. **No cron**: each worker run
removes finished downloads older than 7 days (`DOWNLOAD_TTL_DAYS`) of every
user, `whoami` does the same for the user's own directory, and a worker that
stops reporting (heartbeat older than 90 s) is shown as an error with *Try
again*. At most 2 albums convert at the same time (`DOWNLOAD_SLOTS`).
Constants live at the top of `downloadLib.php`. Requires `exec()` and
`pcntl`/`posix` in PHP (default on Debian/Ubuntu), `www-data` write access to
`tmp/` (`fix-perms.sh`).

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
`cd/flac/<Artist>/<Album>/` directory — drop one in by hand, or use the
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
| `?action=album&id=Artist/Album` | album metadata + tracks: `no`, `disc`, `title`, `artist`, `composer`, `duration`, `codec`, `src` (URL of the FLAC file); `cover`, `thumb` |
| `?action=coverSearch&id=X[&artist=&title=]` | cover candidates from MusicBrainz (release id, title, artist, date, country, format, track count, preview/large image URLs on the Cover Art Archive); nothing is saved |
| `?action=coverSave&id=X` | POST `{mbid}` → downloads the release's front cover as `cover.jpg` (JPEG, max 1200 px) and regenerates the thumbnail (needs the `cover` right, HTTP 403 otherwise) |
| `?action=downloadEstimate&id=X&format=F` | `{size, duration, tracks, exact, tooLarge}` – size of the album in `flac`/`alac`/`aac`/`mp3` (exact for FLAC, estimated otherwise) |
| `?action=downloadPrepare` | POST `{id, format, ascii, replace}` → 202 job state (worker started), 200 when the same album is already prepared, 409 `{status:'exists', job}` when another album is prepared/running and `replace` is false |
| `?action=downloadStatus` | state of the user's download: `status` (`none`, `queued`, `converting`, `packing`, `ready`, `error`), `tracksDone/tracksTotal`, `current`, `file`, `size`, `url`, `message` |
| `?action=downloadCancel`, `?action=downloadDelete` | POST – stops a running preparation / removes the prepared ZIP |

Data actions require authentication (HTTP 401); `coverSave` additionally the `cover` right (HTTP 403); the `download*` actions a password login (HTTP 403 for IP auto-logins). Responses are `Cache-Control: no-store`.

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

### 2. Protecting audio files, covers and downloads (auth_request)

Everything under `cd/`, `covers/` and `tmp/` is served directly by nginx —
but a subrequest first verifies the session against `auth.php` (204 = allow,
403 = deny). For `tmp/` (prepared downloads) `auth.php` also receives the
requested URL in `X_ORIGINAL_URI` and allows only the owner's `*.zip`.

Two complete, commented server blocks are in [nginx/](nginx/) — copy the one
that matches the deployment, adjust `server_name`, `root`, certificates and the
PHP-FPM socket, then `sudo nginx -t && sudo systemctl reload nginx`:

| File | Deployment |
|---|---|
| [nginx/root.conf](nginx/root.conf) | the archive alone in the web root – `https://music.example.com/` |
| [nginx/subdir.conf](nginx/subdir.conf) | several applications in subdirectories of one web root – `https://media.example.com/music/`, `/gallery/`, … (the same file exists in the gallery project; one server block covers all of them) |

The rules that matter, in the subdirectory variant (`/music/`):

```nginx
location ~ ^/music/(?:cd|covers)/ { auth_request /auth-check-music; }
location ~ ^/music/tmp/ {
	auth_request /auth-check-music;
	add_header Content-Disposition attachment;
}
location = /auth-check-music {
	internal;
	include fastcgi_params;
	fastcgi_pass unix:/run/php/php-fpm.sock;
	fastcgi_param SCRIPT_FILENAME $document_root/music/auth.php;
	fastcgi_param X_ORIGINAL_URI $request_uri;
	fastcgi_pass_request_body off;
	fastcgi_param CONTENT_LENGTH "";
}
```

**Upgrading an existing installation** (including one that still uses the
former `snippets/music-auth.conf`): add the `tmp/` location and the
`X_ORIGINAL_URI` line — without them download links return 404, or
`auth.php` denies them.

### 3. Filesystem permissions — fix-perms.sh

PHP-FPM runs as `www-data` and needs **write** access to `cd/` (`.meta.json`,
`cover.jpg`), `covers/`, `tmp/` (prepared downloads) and `config.json`
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
**403**, tmp/ **403**, index and app.js **200**; with credentials API and audio
**200**, another user's download **403**.

## License

[CC BY-NC-SA 4.0](LICENSE) — Attribution – NonCommercial – ShareAlike.
