<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Music</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27%3E%3Ctext y=%27.9em%27 font-size=%2790%27%3E%F0%9F%8E%B5%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="style.css?v=<?= filemtime(__DIR__ . '/style.css') ?>">
</head>
<body>
<header>
  <h1 id="page-title">Music</h1>
  <nav id="breadcrumb"></nav>
  <span id="status"></span>
  <button id="logout" hidden title="Sign out">&#x23FB;</button>
  <button id="fs-toggle" title="Fullscreen">&#x26F6;</button>
</header>
<main id="content">
  <p class="loading">Loading…</p>
</main>
<footer id="player" hidden>
  <div id="pb-cover"></div>
  <div id="pb-info"><div id="pb-title"></div><div id="pb-artist"></div></div>
  <div id="pb-controls">
    <button id="pb-prev" title="Previous"></button>
    <button id="pb-play" title="Play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>
    <button id="pb-next" title="Next"></button>
  </div>
  <div id="pb-progress">
    <span id="pb-time">0:00</span>
    <input id="pb-seek" type="range" min="0" max="1000" value="0">
    <span id="pb-dur">0:00</span>
  </div>
  <input id="pb-volume" type="range" min="0" max="100" value="100" title="Volume">
  <audio id="audio" preload="auto"></audio>
  <audio id="audio2" preload="auto"></audio>   <!-- the next track is preloaded here for gapless playback -->
</footer>
<script src="app.js?v=<?= filemtime(__DIR__ . '/app.js') ?>"></script>
</body>
</html>
