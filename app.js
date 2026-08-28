// Music archive SPA – album overview and player.
// Data is loaded progressively from getData.php (album list, then album
// contents on demand), navigation via hash (#album=Artist/Album).

let DATA = null;
let APP_TITLE = 'Music';   // overridden by "title" from config.json (via whoami)
let RIGHTS = [];                 // permissions of the signed-in user (none used yet)
let CAN_DOWNLOAD = false;        // album downloads: password users only (not @ip:… auto-logins)

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
    CAN_DOWNLOAD = !!who.user && !who.user.startsWith('@');
    updateLogoutButton(who.user);
  } catch (e) {
    content.innerHTML = '<p class="loading">Server is not responding (getData.php).</p>';
    return;
  }
  loadData();
  if (CAN_DOWNLOAD) dlRefresh();   // a download prepared earlier shows up in the header
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
      CAN_DOWNLOAD = !!res.user && !res.user.startsWith('@');
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
    document.getElementById('reload').hidden = false;
    render();
  } catch (e) {
    statusEl.textContent = '';
    content.innerHTML = '<p class="loading">Failed to load the archive (getData.php).</p>';
  }
}

// Re-reads the album list from the server (after CDs were added) without
// touching playback: the album that is playing keeps its object and track
// list so the queue continues; every other album is loaded afresh on demand.
async function reloadData() {
  const btn = document.getElementById('reload');
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    const list = (await fetchJson('getData.php?action=albums')).albums;
    DATA = { albums: list.map(a => {
      const fresh = { ...a, trackCount: a.tracks, tracks: null, loading: null };
      if (player.album && player.album.id === a.id) {
        Object.assign(player.album, fresh, { tracks: player.album.tracks });
        return player.album;
      }
      return fresh;
    }) };
    render();
    flashStatus(`${DATA.albums.length} albums`);
  } catch (e) {
    flashStatus('Reload failed');
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}
document.getElementById('reload').addEventListener('click', () => { if (DATA) reloadData(); });

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

  const list = document.createElement('div');
  list.className = 'album-list';
  const cardOf = album => {
    const card = document.createElement('a');
    card.className = 'album-card' + (player.album === album ? ' playing' : '');
    card.href = '#album=' + hashId(album.id);
    card.innerHTML = coverHtml(album, 'album-cover') +
      `<div class="album-info"><h2>${esc(album.title)}</h2>` +
      `<p>${esc(album.artist)}${album.year ? ' · ' + album.year : ''}</p>` +
      `<p>${album.trackCount} tracks · ${fmtTime(album.duration)}</p></div>`;
    return card;
  };
  // consecutive albums from the same artist directory (the list is sorted by it)
  // form a highlighted group with the directory name above and below; single albums
  // share a plain grid between the groups
  let loose = null;   // current grid of ungrouped albums
  const albums = DATA.albums;
  for (let i = 0; i < albums.length;) {
    let j = i + 1;
    while (j < albums.length && albums[j].artistDir === albums[i].artistDir) j++;
    if (j - i > 1) {
      loose = null;
      const group = document.createElement('section');
      group.className = 'artist-group';
      const grid = document.createElement('div');
      grid.className = 'album-grid';
      for (let k = i; k < j; k++) grid.appendChild(cardOf(albums[k]));
      group.innerHTML = `<h3 class="artist-sep">${esc(albums[i].artistDir)}</h3>`;
      group.appendChild(grid);
      group.insertAdjacentHTML('beforeend', `<h3 class="artist-sep artist-sep-end">${esc(albums[i].artistDir)}</h3>`);
      list.appendChild(group);
    } else {
      if (!loose) { loose = document.createElement('div'); loose.className = 'album-grid'; list.appendChild(loose); }
      loose.appendChild(cardOf(albums[i]));
    }
    i = j;
  }
  content.replaceChildren(list);
}

// ---- album view ----
function renderAlbum(album) {
  document.title = `${album.artist} – ${album.title} – ${APP_TITLE}`;
  // header: [home icon → root] › Album – Artist
  pageTitle.innerHTML = `<a href="#" class="home" title="${esc(APP_TITLE)}" aria-label="${esc(APP_TITLE)}">${ICON.home}</a>` +
    `<span class="crumb-sep">›</span>${esc(album.title)}<span class="title-artist">${esc(album.artist)}</span>`;
  breadcrumb.innerHTML = '';

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
    rows += `<li class="track" data-index="${i}">` +
      `<span class="t-no">${t.no}</span>` +
      `<span class="t-title">${esc(t.title)}` +
      (album.compilation && t.artist ? `<small>${esc(t.artist)}</small>` : '') + `</span>` +
      `<span class="t-dur">${fmtTime(t.duration)}</span></li>`;
  });
  view.innerHTML =
    `<div class="album-head">${coverHtml(album, 'album-big-cover', true)}` +
    `<div class="album-head-info"><h2>${esc(album.title)}</h2><p>${meta}</p>` +
    `<button class="btn-play-album">${ICON.play} Play album</button>` +
    (CAN_DOWNLOAD ? `<button class="btn-cover btn-download" title="Prepare a ZIP of the album in FLAC, ALAC, AAC or MP3">Download…</button>` : '') +
    (RIGHTS.includes('cover') ? `<button class="btn-cover" title="Search the Cover Art Archive">${album.cover ? 'Change cover…' : 'Find cover…'}</button>` +
      `<button class="btn-cover btn-cover-upload" title="Use an image file from this device">Upload cover…</button>` +
      `<input type="file" class="cover-file" accept="image/jpeg,image/png,image/gif,image/webp" hidden>` : '') +
    `</div></div>` +
    `<ol class="track-list">${rows}</ol>`;
  view.querySelector('.btn-play-album').addEventListener('click', () => playAlbum(album, 0));
  view.querySelector('.btn-cover:not(.btn-download)')?.addEventListener('click', () => openCoverPicker(album));
  view.querySelector('.btn-download')?.addEventListener('click', () => openDownload(album));
  const coverFile = view.querySelector('.cover-file');
  view.querySelector('.btn-cover-upload')?.addEventListener('click', () => coverFile.click());
  coverFile?.addEventListener('change', () => { if (coverFile.files[0]) uploadCover(album, coverFile.files[0]); });
  view.querySelectorAll('.track').forEach(li =>
    li.addEventListener('click', () => playAlbum(album, +li.dataset.index)));
  content.replaceChildren(view);
  markPlayingTrack();
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

// applies a freshly saved cover (server reply of coverSave/coverUpload) to the album everywhere
function applySavedCover(album, r) {
  // cache-busting query so the browser shows the new file immediately
  album.cover = r.cover + '?v=' + Date.now();
  album.thumb = r.thumb ? r.thumb + '?v=' + Date.now() : null;
  flashStatus('Cover saved');
  render();
  if (player.album === album) pbCover.innerHTML = coverHtml(album, 'pb-cover-img');
}

// uploads the user's own image file as the album cover
async function uploadCover(album, file) {
  if (album.cover && !confirm(`Replace the current cover of ${album.artist} – ${album.title} with "${file.name}"?`)) return;
  const body = new FormData();
  body.append('cover', file);
  flashStatus('Uploading cover…');
  try {
    const r = await fetchJson('getData.php?action=coverUpload&id=' + encodeURIComponent(album.id), { method: 'POST', body });
    applySavedCover(album, r);
  } catch (e) {
    flashStatus('Upload failed: ' + e.message);
  }
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
      dlg.remove();
      picker.remove();
      applySavedCover(album, r);
    } catch (e) {
      status.textContent = 'Saving failed: ' + e.message;
      dlg.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  });
}

// ---- album download ----
// The server prepares ONE album per user as a ZIP in tmp/<user>/ (background
// worker, see downloadLib.php); the browser polls its state every 2 s while
// something is running and shows it in the dialog and in the header badge.
const DL_FORMATS = [
  ['flac', 'FLAC', 'lossless, the archive files as they are – ready immediately'],
  ['alac', 'ALAC', 'Apple Lossless – iPhone, iPad, Apple Music library'],
  ['aac', 'AAC 256 kb/s', 'small files, plays everywhere (.m4a)'],
  ['mp3', 'MP3 V0', 'car radios and older players (~245 kb/s)'],
];
const dl = { job: { status: 'none' }, timer: null, album: null, notify: false, tooLarge: false };

function fmtSize(b) {
  return b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.round(b / 1e3) + ' kB';
}
function dlLabel(job) {
  return `${job.artist} – ${job.title} [${(DL_FORMATS.find(f => f[0] === job.format) || [, job.format])[1]}]`;
}
function dlRunning(job) { return ['queued', 'converting', 'packing'].includes(job.status); }

async function dlRefresh() {
  try { dl.job = await fetchJson('getData.php?action=downloadStatus'); } catch (e) { return; }
  dlRender();
  clearTimeout(dl.timer);
  if (dlRunning(dl.job)) dl.timer = setTimeout(dlRefresh, 2000);
  else if (dl.job.status === 'ready' && dl.notify) {
    dl.notify = false;
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(APP_TITLE, { body: `Download ready: ${dlLabel(dl.job)}` });
  }
}

// header badge + dialog contents follow dl.job
function dlRender() {
  const badge = document.getElementById('dl-badge');
  const job = dl.job;
  badge.hidden = job.status === 'none';
  if (!badge.hidden) {
    badge.classList.toggle('busy', dlRunning(job));
    badge.classList.toggle('error', job.status === 'error');
    badge.title = job.status === 'ready' ? `Download ready: ${dlLabel(job)}` : job.status === 'error' ? `Download failed: ${dlLabel(job)}` : `Preparing ${dlLabel(job)}…`;
    badge.innerHTML = job.status === 'ready' ? '&#x2B73;' : job.status === 'error' ? '&#x26A0;' : '&#x21BB;';
  }
  const dlg = document.getElementById('dl-dialog');
  if (dlg) dlDialogState(dlg);
}

// the dialog: format choice for the open album, or the state of the prepared download
async function openDownload(album) {
  document.getElementById('dl-dialog')?.remove();
  dl.album = album ?? null;
  const dlg = document.createElement('div');
  dlg.id = 'dl-dialog';
  const opts = DL_FORMATS.map(([k, l, d], i) =>
    `<label class="dl-format"><input type="radio" name="format" value="${k}"${i === 0 ? ' checked' : ''}><b>${l}</b><small>${d}</small></label>`).join('');
  dlg.innerHTML =
    '<div class="cp-box dl-box">' +
    '<button class="cp-close" title="Close">&times;</button>' +
    (album ? `<h2>Download ${esc(album.artist)} – ${esc(album.title)}</h2>` +
      `<form class="dl-form">${opts}` +
      '<label class="dl-ascii"><input type="checkbox" name="ascii"> File names without accents (FAT32 sticks, car radios)</label>' +
      '<p class="cp-status dl-estimate"></p>' +
      '<div class="cp-actions"><button type="submit" class="dl-prepare">Prepare download</button></div></form>' : '<h2>Prepared download</h2>') +
    '<div class="dl-state"></div>' +
    '</div>';
  document.body.appendChild(dlg);
  const close = () => dlg.remove();
  dlg.querySelector('.cp-close').addEventListener('click', close);
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  const form = dlg.querySelector('.dl-form');
  if (form) {
    const estimate = async () => {
      const el = dlg.querySelector('.dl-estimate');
      el.textContent = 'Estimating size…';
      try {
        const r = await fetchJson(`getData.php?action=downloadEstimate&id=${encodeURIComponent(album.id)}&format=${form.format.value}`);
        el.textContent = `${r.tracks} tracks · ${fmtTime(r.duration)} · ${r.exact ? '' : '≈ '}${fmtSize(r.size)}` +
          (r.tooLarge ? ' – too large for a ZIP (4 GB limit)' : '');
        dl.tooLarge = !!r.tooLarge;
        dlDialogState(dlg);
      } catch (e) { el.textContent = ''; }
    };
    form.addEventListener('change', e => { if (e.target.name === 'format') estimate(); });
    form.addEventListener('submit', e => { e.preventDefault(); dlPrepare(album, form.format.value, form.ascii.checked, false); });
    estimate();
  }
  dlDialogState(dlg);
  dlRefresh();
}

function dlDialogState(dlg) {
  const job = dl.job, box = dlg.querySelector('.dl-state');
  const form = dlg.querySelector('.dl-form');
  if (form) form.querySelectorAll('input, button').forEach(el => { el.disabled = dlRunning(job) || (el.classList.contains('dl-prepare') && dl.tooLarge); });
  if (job.status === 'none') { box.innerHTML = form ? '' : '<p class="cp-status">Nothing is prepared.</p>'; return; }
  const who = `<b>${esc(dlLabel(job))}</b>`;
  let html;
  if (job.status === 'queued') html = `<p>${who}</p><p class="cp-status">Waiting for a free conversion slot…</p>`;
  else if (job.status === 'converting') {
    const pct = job.tracksTotal ? Math.round(job.tracksDone / job.tracksTotal * 100) : 0;
    html = `<p>${who}</p><progress max="100" value="${pct}"></progress>` +
      `<p class="cp-status">Converting ${job.tracksDone}/${job.tracksTotal}${job.current ? ' – ' + esc(job.current) : ''}</p>`;
  } else if (job.status === 'packing') html = `<p>${who}</p><progress max="100"></progress><p class="cp-status">Packing the ZIP…</p>`;
  else if (job.status === 'ready') html = `<p>${who} · ${fmtSize(job.size)}</p>` +
    `<div class="cp-actions"><a class="dl-link" href="${job.url}" download>${ICON.download} Download ZIP</a><button class="cp-cancel dl-delete">Delete</button></div>` +
    '<p class="cp-status">Kept for a week, or until you prepare another album.</p>';
  else html = `<p>${who}</p><p class="cp-status dl-error">Failed: ${esc(job.message || 'unknown error')}</p>` +
    `<div class="cp-actions">${dl.album && dl.album.id === job.id ? '<button class="dl-retry">Try again</button>' : ''}<button class="cp-cancel dl-delete">Dismiss</button></div>`;
  if (dlRunning(job)) html += '<div class="cp-actions"><button class="cp-cancel dl-cancel">Cancel</button></div>';
  box.innerHTML = html;
  box.querySelector('.dl-cancel, .dl-delete')?.addEventListener('click', async () => {
    try { await fetchJson('getData.php?action=downloadCancel', { method: 'POST' }); } catch (e) { /* refresh shows the truth */ }
    dlRefresh();
  });
  box.querySelector('.dl-retry')?.addEventListener('click', () => dlPrepare(dl.album, job.format, job.ascii, true));
}

async function dlPrepare(album, format, ascii, replace) {
  const res = await fetch('getData.php?action=downloadPrepare', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: album.id, format, ascii, replace }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.status === 'exists') {
    const j = data.job;
    const what = dlRunning(j) ? `${dlLabel(j)} is being prepared right now` : `${dlLabel(j)} (${fmtSize(j.size)}) is ready for download`;
    if (confirm(`${what}. Only one album can be prepared at a time – replace it?`)) return dlPrepare(album, format, ascii, true);
    return;
  }
  if (!res.ok) { flashStatus('Download failed: ' + (data.error || res.status)); return; }
  if (dlRunning(data)) {
    dl.notify = true;
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }
  dl.job = data;
  dlRender();
  dlRefresh();
}

document.getElementById('dl-badge').addEventListener('click', () => {
  const m = currentAlbumId();
  const album = m !== null && dl.job.id === m ? DATA.albums.find(a => a.id === m) : null;
  openDownload(album);
});

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
  home: '<svg viewBox="0 0 24 24"><path d="M12 3 2 12h3v8h6v-6h2v6h6v-8h3z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5zm7-18-6 8h4v6h4v-6h4z"/></svg>',
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
  const src = t.src;
  gapless.armed = false;
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
  pbTitle.textContent = t.title;
  pbArtist.textContent = (t.artist || album.artist) + ' – ' + album.title;
  pbCover.innerHTML = coverHtml(album, 'pb-cover-img');
  pbCover.onclick = () => { location.hash = '#album=' + hashId(album.id); };
  pbDur.textContent = fmtTime(t.duration);
  bar.hidden = false;
  document.body.classList.add('has-player');
  markPlayingTrack();
  updatePlayButton();   // after a gapless swap the new element is already playing and fires no 'play' event
  updateMediaSession(album, t);
}

// the button state is derived from the element, not from events: at the natural end
// of a file the browser fires 'pause' before 'ended', which would otherwise leave the
// button showing "stopped" while the gapless-started next track keeps playing
function updatePlayButton() {
  pbPlay.innerHTML = audio.paused ? ICON.play : ICON.pause;
  pbPlay.title = audio.paused ? 'Play' : 'Pause';
}

// Two <audio> elements: `audio` plays, `nextAudio` preloads the following track
// so that album transitions (Tubular Bells…) are gapless – it is started exactly
// when the current file runs out and the two elements swap roles.
let audio = document.getElementById('audio');
let nextAudio = document.getElementById('audio2');

// loads the following track into the idle element (only when its file already exists)
function preloadNext(album, index) {
  const n = album.tracks[index + 1];
  const src = n ? n.src : null;
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
  if (!n || !nextAudio.dataset.src || nextAudio.dataset.src !== n.src || nextAudio.readyState < 3) return;
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
  el.addEventListener('play', () => { if (el !== audio) return; updatePlayButton(); markPlayingTrack(); });
  el.addEventListener('pause', () => { if (el !== audio) return; updatePlayButton(); markPlayingTrack(); });
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
    const dlg = document.getElementById('cover-confirm') || document.getElementById('cover-picker') || document.getElementById('dl-dialog');
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
