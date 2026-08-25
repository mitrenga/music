// Music archive SPA – album overview and player.
// Data is loaded progressively from getData.php (album list, then album
// contents on demand), navigation via hash (#album=Artist/Album).

let DATA = null;
let APP_TITLE = 'Music';   // overridden by "title" from config.json (via whoami)
let RIGHTS = [];                 // permissions of the signed-in user (none used yet)

const content = document.getElementById('content');
const breadcrumb = document.getElementById('breadcrumb');
const pageTitle = document.getElementById('page-title');
const statusEl = document.getElementById('status');

async function fetchJson(url, opts) {
  const res = await fetch(url, { cache: 'no-store', ...opts });   // always fresh data, never from cache
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function init() {
  window.addEventListener('hashchange', render);
  try {
    // authentication check – allowed IPs pass automatically
    const who = await fetchJson('getData.php?action=whoami');
    if (who.title) {
      APP_TITLE = who.title;
      pageTitle.textContent = APP_TITLE;   // visible already on the login screen
      document.title = APP_TITLE;
    }
    // a password-reset link (?reset=TOKEN) takes precedence over the normal flow
    const resetToken = new URLSearchParams(location.search).get('reset');
    if (resetToken) {
      showReset(resetToken);
      return;
    }
    if (!who.auth) {
      showLogin();
      return;
    }
    RIGHTS = who.rights || [];
    updateLogoutButton(who.user);
  } catch (e) {
    content.innerHTML = '<p class="loading">Server is not responding (getData.php).</p>';
    return;
  }
  loadData();
}

// ---- login ----
// The logout button only makes sense for password logins;
// internal accounts (@ip:…, @noconfig) would immediately sign in again.
function updateLogoutButton(user) {
  const btn = document.getElementById('logout');
  btn.hidden = !user || user.startsWith('@');
  btn.title = `Sign out ${user}`;
  document.body.classList.toggle('has-logout', !btn.hidden);
}

document.getElementById('logout').addEventListener('click', async () => {
  try { await fetchJson('getData.php?action=logout'); } catch (e) { /* session ends either way */ }
  location.reload();   // shows the login dialog again, or auto-signs in by IP
});

function showLogin() {
  content.innerHTML = '';
  const dlg = document.createElement('div');
  dlg.id = 'login';
  dlg.innerHTML =
    '<form class="login-box">' +
    '<h2>Sign in</h2>' +
    '<input type="text" name="user" placeholder="Username" autocomplete="username" required>' +
    '<input type="password" name="password" placeholder="Password" autocomplete="current-password" required>' +
    '<button type="submit">Sign in</button>' +
    '<a href="#" class="login-link">Forgot password?</a>' +
    '<p class="login-error"></p>' +
    '</form>';
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  form.user.focus();
  dlg.querySelector('.login-link').addEventListener('click', e => {
    e.preventDefault();
    dlg.remove();
    showForgot();
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = dlg.querySelector('.login-error');
    errEl.textContent = '';
    try {
      const res = await fetchJson('getData.php?action=login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: form.user.value, password: form.password.value }),
      });
      RIGHTS = res.rights || [];
      dlg.remove();
      updateLogoutButton(form.user.value);
      loadData();
    } catch (err) {
      errEl.textContent = 'Invalid username or password';
      form.password.value = '';
      form.password.focus();
    }
  });
}

// forgot password – asks for an e-mail and requests a reset link
function showForgot() {
  content.innerHTML = '';
  const dlg = document.createElement('div');
  dlg.id = 'login';
  dlg.innerHTML =
    '<form class="login-box">' +
    '<h2>Password reset</h2>' +
    '<input type="email" name="email" placeholder="E-mail" autocomplete="email" required>' +
    '<button type="submit">Send reset link</button>' +
    '<a href="#" class="login-link">Back to sign in</a>' +
    '<p class="login-error"></p>' +
    '</form>';
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  form.email.focus();
  dlg.querySelector('.login-link').addEventListener('click', e => {
    e.preventDefault();
    dlg.remove();
    showLogin();
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = dlg.querySelector('.login-error');
    errEl.textContent = '';
    try {
      await fetchJson('getData.php?action=resetRequest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email.value }),
      });
      // the server always says ok – it never reveals whether the e-mail exists
      errEl.classList.add('login-info');
      errEl.textContent = 'If the e-mail is registered, a reset link has been sent.';
    } catch (err) {
      errEl.classList.remove('login-info');
      errEl.textContent = 'Server error, please try again.';
    }
  });
}

// sets a new password using the token from the e-mailed ?reset=... link
function showReset(token) {
  content.innerHTML = '';
  const dlg = document.createElement('div');
  dlg.id = 'login';
  dlg.innerHTML =
    '<form class="login-box">' +
    '<h2>New password</h2>' +
    '<input type="password" name="password" placeholder="New password (min 8 characters)"' +
    ' autocomplete="new-password" minlength="8" required>' +
    '<button type="submit">Save password</button>' +
    '<p class="login-error"></p>' +
    '</form>';
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  form.password.focus();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = dlg.querySelector('.login-error');
    errEl.textContent = '';
    try {
      await fetchJson('getData.php?action=resetPassword', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: form.password.value }),
      });
      location.href = location.pathname;   // clean reload -> sign-in with the new password
    } catch (err) {
      errEl.textContent = 'The link is invalid or expired.';
    }
  });
}

// ---- data ----
async function loadData() {
  try {
    statusEl.textContent = 'Loading album list…';
    const list = (await fetchJson('getData.php?action=albums')).albums;
    DATA = { albums: list.map(a => ({ ...a, trackCount: a.tracks, tracks: null, loading: null })) };
    statusEl.textContent = '';
    render();
  } catch (e) {
    statusEl.textContent = '';
    content.innerHTML = '<p class="loading">Failed to load the archive (getData.php).</p>';
  }
}

// fetches the track list if not loaded yet (concurrent callers share one fetch)
function ensureAlbum(album) {
  if (album.tracks) return Promise.resolve(album);
  if (!album.loading) {
    album.loading = fetchJson('getData.php?action=album&id=' + encodeURIComponent(album.id))
      .then(d => {
        album.tracks = d.tracks;
        album.cover = d.cover;
        album.thumb = d.thumb;
        album.compilation = d.compilation;
        album.discs = d.discs;
        return album;
      })
      .finally(() => { album.loading = null; });
  }
  return album.loading;
}

function render() {
  const m = location.hash.match(/^#album=(.+)$/);
  if (m) {
    const album = DATA.albums.find(a => a.id === decodeURIComponent(m[1]));
    if (album) return renderAlbum(album);
  }
  renderOverview();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

// cover image or a generated placeholder (hue derived from the album id)
function coverHtml(album, cls, full = false) {
  const src = full ? (album.cover || album.thumb) : (album.thumb || album.cover);
  if (src) return `<img class="${cls}" src="${src}" alt="" loading="lazy">`;
  let h = 0;
  for (const c of album.id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<div class="${cls} cover-placeholder" style="--hue:${h}"><span>${esc(album.artist)}</span><b>${esc(album.title)}</b></div>`;
}

// ---- album overview ----
function renderOverview() {
  pageTitle.textContent = APP_TITLE;
  breadcrumb.innerHTML = '';
  document.title = APP_TITLE;

  const grid = document.createElement('div');
  grid.className = 'album-grid';
  for (const album of DATA.albums) {
    const card = document.createElement('a');
    card.className = 'album-card' + (player.album === album ? ' playing' : '');
    card.href = '#album=' + hashId(album.id);
    card.innerHTML = coverHtml(album, 'album-cover') +
      `<div class="album-info"><h2>${esc(album.title)}</h2>` +
      `<p>${esc(album.artist)}${album.year ? ' · ' + album.year : ''}</p>` +
      `<p>${album.trackCount} tracks · ${fmtTime(album.duration)}</p></div>`;
    grid.appendChild(card);
  }
  content.replaceChildren(grid);
}

// ---- album view ----
function renderAlbum(album) {
  pageTitle.textContent = album.title;
  document.title = `${album.artist} – ${album.title} – ${APP_TITLE}`;
  breadcrumb.innerHTML = `<a href="#">${esc(APP_TITLE)}</a> › ${esc(album.artist)}`;

  if (!album.tracks) {
    content.innerHTML = '<p class="loading">Loading tracks…</p>';
    ensureAlbum(album).then(() => {
      const m = location.hash.match(/^#album=(.+)$/);
      if (m && decodeURIComponent(m[1]) === album.id) renderAlbum(album);
    }).catch(() => { content.innerHTML = '<p class="loading">Failed to load the album.</p>'; });
    return;
  }

  const view = document.createElement('div');
  view.className = 'album-view';
  const meta = [album.artist, album.year, album.genre, `${album.tracks.length} tracks`, fmtTime(album.duration)]
    .filter(Boolean).map(esc).join(' · ');
  let rows = '';
  let lastDisc = null;
  album.tracks.forEach((t, i) => {
    if (album.discs > 1 && t.disc !== lastDisc) {
      rows += `<li class="disc">Disc ${t.disc}</li>`;
      lastDisc = t.disc;
    }
    rows += `<li class="track${trackSource(t) ? '' : ' converting'}" data-index="${i}" title="${trackSource(t) ? '' : 'Converting to ' + FORMAT.toUpperCase() + '…'}">` +
      `<span class="t-no">${t.no}</span>` +
      `<span class="t-title">${esc(t.title)}` +
      (album.compilation && t.artist ? `<small>${esc(t.artist)}</small>` : '') + `</span>` +
      `<span class="t-dur">${fmtTime(t.duration)}</span></li>`;
  });
  view.innerHTML =
    `<div class="album-head">${coverHtml(album, 'album-big-cover', true)}` +
    `<div class="album-head-info"><h2>${esc(album.title)}</h2><p>${meta}</p>` +
    `<button class="btn-play-album">${ICON.play} Play album</button>` +
    (RIGHTS.includes('cover') ? `<button class="btn-cover" title="Search the Cover Art Archive">${album.cover ? 'Change cover…' : 'Find cover…'}</button>` : '') +
    `</div></div>` +
    `<ol class="track-list">${rows}</ol>`;
  view.querySelector('.btn-play-album').addEventListener('click', () => playAlbum(album, 0));
  view.querySelector('.btn-cover')?.addEventListener('click', () => openCoverPicker(album));
  view.querySelectorAll('.track').forEach(li =>
    li.addEventListener('click', () => playAlbum(album, +li.dataset.index)));
  content.replaceChildren(view);
  markPlayingTrack();
  // tracks still being converted: refresh the list until all are playable
  if (album.tracks.some(t => !trackSource(t)) && !pending) {
    clearTimeout(renderAlbum.refresh);
    renderAlbum.refresh = setTimeout(async () => {
      if (currentAlbumId() !== album.id) return;
      try {
        album.tracks = (await fetchJson('getData.php?action=album&id=' + encodeURIComponent(album.id))).tracks;
      } catch (e) { /* keep the old list */ }
      renderAlbum(album);
    }, 5000);
  }
}

// highlights the playing track in the open album (and the album card in the overview)
function markPlayingTrack() {
  document.querySelectorAll('.track').forEach(li => {
    const on = player.album && player.album.tracks && player.album.id === currentAlbumId()
      && +li.dataset.index === player.index;
    li.classList.toggle('playing', !!on);
    li.classList.toggle('paused', !!on && audio.paused);
  });
}

// Encode an album id for the URL hash: each path segment separately so the "/" stays
// readable in the address bar (browsers show %20 as a space but keep %2F encoded).
function hashId(id) {
  return id.split('/').map(encodeURIComponent).join('/');
}

function currentAlbumId() {
  const m = location.hash.match(/^#album=(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// ---- cover picker ----
// Searches MusicBrainz for releases of the album, previews their Cover Art
// Archive front images and saves the one the user confirms.
async function openCoverPicker(album, artist, title) {
  document.getElementById('cover-picker')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'cover-picker';
  dlg.innerHTML =
    '<div class="cp-box">' +
    '<button class="cp-close" title="Close">&times;</button>' +
    `<h2>Cover for ${esc(album.artist)} – ${esc(album.title)}</h2>` +
    '<form class="cp-query"><input name="artist" placeholder="Artist"><input name="title" placeholder="Album"><button type="submit">Search</button></form>' +
    '<p class="cp-status">Searching MusicBrainz…</p>' +
    '<div class="cp-grid"></div>' +
    '</div>';
  document.body.appendChild(dlg);
  const close = () => dlg.remove();
  dlg.querySelector('.cp-close').addEventListener('click', close);
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  const form = dlg.querySelector('.cp-query');
  form.artist.value = artist ?? album.artist;
  form.title.value = title ?? album.title;
  form.addEventListener('submit', e => { e.preventDefault(); openCoverPicker(album, form.artist.value, form.title.value); });

  const status = dlg.querySelector('.cp-status');
  const grid = dlg.querySelector('.cp-grid');
  let res;
  try {
    res = await fetchJson('getData.php?action=coverSearch&id=' + encodeURIComponent(album.id) +
      '&artist=' + encodeURIComponent(form.artist.value) + '&title=' + encodeURIComponent(form.title.value));
  } catch (e) {
    status.textContent = 'MusicBrainz search failed – try again in a moment.';
    return;
  }
  if (!res.candidates.length) { status.textContent = 'No matching release found – adjust the query above.'; return; }
  status.textContent = 'Loading artwork…';
  let shown = 0, pending = res.candidates.length;
  const settle = () => { if (--pending === 0) status.textContent = shown ? 'Click a cover to preview it.' : 'No release with artwork found – adjust the query above.'; };
  for (const c of res.candidates) {
    const card = document.createElement('div');
    card.className = 'cp-card';
    card.hidden = true;   // shown only when the Cover Art Archive has a front image
    const info = [c.date, c.country, c.format, c.tracks ? c.tracks + ' tracks' : null].filter(Boolean).join(' · ');
    card.innerHTML = `<img src="${c.preview}" alt=""><div><b>${esc(c.title)}</b><br>${esc(c.artist)}<br><small>${esc(info)}</small></div>`;
    const img = card.querySelector('img');
    img.addEventListener('load', () => { card.hidden = false; shown++; settle(); });
    img.addEventListener('error', () => settle());
    card.addEventListener('click', () => confirmCover(album, c, dlg));
    grid.appendChild(card);
  }
}

// large preview + explicit confirmation before anything is written to disk
function confirmCover(album, c, picker) {
  const dlg = document.createElement('div');
  dlg.id = 'cover-confirm';
  const info = [c.date, c.country, c.format, c.tracks ? c.tracks + ' tracks' : null].filter(Boolean).join(' · ');
  dlg.innerHTML =
    '<div class="cp-box cp-confirm">' +
    `<img src="${c.large}" alt="">` +
    `<h2>${esc(c.title)}</h2><p>${esc(c.artist)}<br><small>${esc(info)}</small></p>` +
    `<p>Save this cover for <b>${esc(album.artist)} – ${esc(album.title)}</b>?` +
    (album.cover ? ' The current cover will be replaced.' : '') + '</p>' +
    '<div class="cp-actions"><button class="cp-cancel">Back</button><button class="cp-save">Save cover</button></div>' +
    '<p class="cp-status"></p>' +
    '</div>';
  document.body.appendChild(dlg);
  dlg.querySelector('.cp-cancel').addEventListener('click', () => dlg.remove());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
  dlg.querySelector('.cp-save').addEventListener('click', async () => {
    const status = dlg.querySelector('.cp-status');
    dlg.querySelectorAll('button').forEach(b => b.disabled = true);
    status.textContent = 'Downloading…';
    try {
      const r = await fetchJson('getData.php?action=coverSave&id=' + encodeURIComponent(album.id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mbid: c.mbid }),
      });
      // cache-busting query so the browser shows the new file immediately
      album.cover = r.cover + '?v=' + Date.now();
      album.thumb = r.thumb ? r.thumb + '?v=' + Date.now() : null;
      dlg.remove();
      picker.remove();
      flashStatus('Cover saved');
      render();
      if (player.album === album) pbCover.innerHTML = coverHtml(album, 'pb-cover-img');
    } catch (e) {
      status.textContent = 'Saving failed: ' + e.message;
      dlg.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  });
}

function flashStatus(msg) {
  statusEl.textContent = msg;
  setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 2500);
}

// ---- player ----
// The queue is the album the user started; it survives navigation because the
// player bar lives outside #content.
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
};
document.getElementById('pb-prev').innerHTML = ICON.prev;
document.getElementById('pb-next').innerHTML = ICON.next;
const player = { album: null, index: -1 };
const bar = document.getElementById('player');
const pbCover = document.getElementById('pb-cover');
const pbTitle = document.getElementById('pb-title');
const pbArtist = document.getElementById('pb-artist');
const pbPlay = document.getElementById('pb-play');
const pbSeek = document.getElementById('pb-seek');
const pbTime = document.getElementById('pb-time');
const pbDur = document.getElementById('pb-dur');
const pbVolume = document.getElementById('pb-volume');

function playAlbum(album, index) {
  ensureAlbum(album).then(() => playTrack(album, index));
}

function playTrack(album, index) {
  if (!album.tracks || index < 0 || index >= album.tracks.length) return;
  player.album = album;
  player.index = index;
  const t = album.tracks[index];
  const src = trackSource(t);
  pending = null;
  gapless.armed = false;
  if (!src) {
    // copy in the chosen format not derived yet – the server is converting; poll until it appears
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    statusEl.textContent = 'Converting…';
    pending = { album, index };
    setTimeout(pollPending, 5000);
  } else {
    statusEl.textContent = '';
    if (nextAudio.dataset.src === src && nextAudio.readyState >= 2) {
      // the preloaded element already holds this file – swap roles instead of reloading
      audio.pause();
      [audio, nextAudio] = [nextAudio, audio];
      if (audio.paused) audio.play().catch(() => {});   // already started by the gapless switch, or start now
    } else {
      audio.src = src;
      audio.dataset.src = src;
      audio.play().catch(() => {});   // autoplay policy: the user clicked, so this normally succeeds
    }
    preloadNext(album, index);
  }
  pbTitle.textContent = t.title;
  pbArtist.textContent = (t.artist || album.artist) + ' – ' + album.title;
  pbCover.innerHTML = coverHtml(album, 'pb-cover-img');
  pbCover.onclick = () => { location.hash = '#album=' + hashId(album.id); };
  pbDur.textContent = fmtTime(t.duration);
  bar.hidden = false;
  document.body.classList.add('has-player');
  markPlayingTrack();
  updateMediaSession(album, t);
}

// Playback format chosen by the user: 'alac' (the master – only browsers that
// decode ALAC, i.e. Safari), 'flac' (lossless) or 'aac' (256 kb/s, a third of
// the data – the default). Remembered in localStorage.
const FORMATS = { alac: 'ALAC · original', flac: 'FLAC · lossless', aac: 'AAC · 256 kb/s' };
// Two <audio> elements: `audio` plays, `nextAudio` preloads the following track
// so that album transitions (Tubular Bells…) are gapless – it is started exactly
// when the current file runs out and the two elements swap roles.
let audio = document.getElementById('audio');
let nextAudio = document.getElementById('audio2');
if (audio.canPlayType('audio/mp4; codecs="alac"') !== 'probably') delete FORMATS.alac;
let FORMAT = 'aac';
try { if (FORMATS[localStorage.getItem('music.format')]) FORMAT = localStorage.getItem('music.format'); } catch (e) { /* ignore */ }
const pbFormat = document.getElementById('pb-format');
pbFormat.innerHTML = Object.entries(FORMATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
pbFormat.value = FORMAT;
pbFormat.addEventListener('change', () => {
  FORMAT = pbFormat.value;
  try { localStorage.setItem('music.format', FORMAT); } catch (e) { /* private mode */ }
  // switch the running track to the new format at the same position
  if (player.album) {
    const pos = audio.currentTime, wasPlaying = !audio.paused;
    nextAudio.removeAttribute('src'); delete nextAudio.dataset.src; nextAudio.load();   // preloaded in the old format
    playTrack(player.album, player.index);
    if (audio.src) {
      // seeking is only possible once the new file's metadata is known
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = pos; }, { once: true });
      if (!wasPlaying) audio.pause();
    }
  }
  if (currentAlbumId()) render();   // ⏳ marks depend on the format
});

// URL of the track in the chosen format, or null while that copy is still being converted
function trackSource(t) {
  return t.formats ? t.formats[FORMAT] : null;
}

let pending = null;   // {album, index} waiting for its AAC copy
async function pollPending() {
  if (!pending) return;
  const { album, index } = pending;
  try {
    const d = await fetchJson('getData.php?action=album&id=' + encodeURIComponent(album.id));
    album.tracks = d.tracks;
    if (currentAlbumId() === album.id) renderAlbum(album);
  } catch (e) { /* retry below */ }
  if (pending && pending.album === album && pending.index === index) {
    if (trackSource(album.tracks[index])) playTrack(album, index);
    else setTimeout(pollPending, 5000);
  }
}

// loads the following track into the idle element (only when its file already exists)
function preloadNext(album, index) {
  const n = album.tracks[index + 1];
  const src = n ? trackSource(n) : null;
  nextAudio.pause();
  if (src) {
    if (nextAudio.dataset.src !== src) { nextAudio.src = src; nextAudio.dataset.src = src; nextAudio.load(); }
    nextAudio.currentTime = 0;
  } else {
    nextAudio.removeAttribute('src'); delete nextAudio.dataset.src; nextAudio.load();
  }
}

// Gapless switch: shortly before the end of the current file a timer starts the
// preloaded next track at the exact moment the current one runs out; the
// 'ended' event then only swaps the UI (playTrack sees the element is playing).
const gapless = { armed: false };
// how many ms BEFORE the computed end the next track is started; a small overlap
// hides the click some browsers produce when the switch lands exactly on the end
const GAPLESS_LEAD_MS = 50;
function armGapless() {
  if (gapless.armed || !player.album || audio.paused || !isFinite(audio.duration)) return;
  const remaining = audio.duration - audio.currentTime;
  if (remaining > 0.5) return;
  const n = player.album.tracks[player.index + 1];
  if (!n || !nextAudio.dataset.src || nextAudio.dataset.src !== trackSource(n) || nextAudio.readyState < 3) return;
  gapless.armed = true;
  setTimeout(() => {
    if (!gapless.armed || audio.paused) { gapless.armed = false; return; }
    nextAudio.play().catch(() => {});   // starts while the last samples of the current file play out
  }, Math.max(0, remaining * 1000 - GAPLESS_LEAD_MS));
}

function step(dir) {
  if (!player.album) return;
  const next = player.index + dir;
  if (next >= 0 && next < player.album.tracks.length) playTrack(player.album, next);
  else if (dir > 0) { audio.pause(); audio.currentTime = 0; gapless.armed = false; markPlayingTrack(); }   // end of album – stop
}

function togglePlay() {
  if (!player.album) return;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

// events are bound to both elements; handlers ignore the one that is only preloading
for (const el of [audio, nextAudio]) {
  el.addEventListener('ended', () => { if (el === audio) step(1); });
  el.addEventListener('play', () => { if (el !== audio) return; pbPlay.innerHTML = ICON.pause; pbPlay.title = 'Pause'; markPlayingTrack(); });
  el.addEventListener('pause', () => { if (el !== audio) return; pbPlay.innerHTML = ICON.play; pbPlay.title = 'Play'; markPlayingTrack(); });
  el.addEventListener('timeupdate', () => {
    if (el !== audio) return;
    if (!pbSeek.matches(':active')) pbSeek.value = audio.duration ? audio.currentTime / audio.duration * 1000 : 0;
    pbTime.textContent = fmtTime(audio.currentTime);
    armGapless();
  });
  el.addEventListener('seeking', () => { if (el === audio) gapless.armed = false; });
  el.addEventListener('durationchange', () => { if (el === audio && isFinite(audio.duration)) pbDur.textContent = fmtTime(audio.duration); });
  el.addEventListener('error', () => {
    if (el !== audio) { delete nextAudio.dataset.src; return; }   // a broken preload is simply dropped
    statusEl.textContent = 'Playback error'; setTimeout(() => step(1), 1500);
  });
}

pbPlay.addEventListener('click', togglePlay);
document.getElementById('pb-prev').addEventListener('click', () => {
  // like a CD player: within the first 3 s go to the previous track, otherwise restart
  if (audio.currentTime > 3 || player.index === 0) audio.currentTime = 0; else step(-1);
});
document.getElementById('pb-next').addEventListener('click', () => step(1));
pbSeek.addEventListener('input', () => { if (audio.duration) audio.currentTime = pbSeek.value / 1000 * audio.duration; });
pbVolume.addEventListener('input', () => {
  audio.volume = nextAudio.volume = pbVolume.value / 100;
  try { localStorage.setItem('music.volume', pbVolume.value); } catch (e) { /* private mode */ }
});
try {
  const v = localStorage.getItem('music.volume');
  if (v !== null) { pbVolume.value = v; audio.volume = nextAudio.volume = v / 100; }
} catch (e) { /* ignore */ }

// lock-screen / headset controls with the album cover as artwork
function updateMediaSession(album, t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist || album.artist, album: album.title,
    artwork: album.cover ? [{ src: new URL(album.cover, location.href).href }] : [],
  });
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
}

document.addEventListener('keydown', e => {
  if (!DATA || e.target.matches('input, textarea')) return;   // not before login, not in the login form
  if (e.key === 'Escape' && document.fullscreenElement) return;   // Esc only leaves fullscreen
  if (e.key === 'Escape') {
    const dlg = document.getElementById('cover-confirm') || document.getElementById('cover-picker');
    if (dlg) { dlg.remove(); return; }
  }
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'Escape' && currentAlbumId() !== null) location.hash = '';
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}

document.getElementById('fs-toggle').addEventListener('click', toggleFullscreen);

document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  const btn = document.getElementById('fs-toggle');
  btn.title = on ? 'Exit fullscreen' : 'Fullscreen';
  btn.classList.toggle('active', on);
});


init();
