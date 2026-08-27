<?php
// Background worker: converts one album into the format the user chose and
// packs it into a ZIP in tmp/<userKey>/. Started detached by getData.php
// (action=downloadPrepare):
//
//   nohup php download-worker.php <userKey> >/dev/null 2>&1 &
//
// Everything it needs is in tmp/<userKey>/job.json (written by the API):
// album, format, track list, source directory. Progress is reported back
// into the same file (status, tracksDone, heartbeat); the browser polls it
// through getData.php?action=downloadStatus. No cron: the worker also removes
// expired downloads of every user before it starts.
if (PHP_SAPI !== 'cli') { http_response_code(403); exit; }
require __DIR__ . '/downloadLib.php';

$key = $argv[1] ?? '';
if (!preg_match('/^u-[A-Za-z0-9._-]{1,60}$/', $key)) { fwrite(STDERR, "usage: download-worker.php <userKey>\n"); exit(1); }
$dir = downloadRoot() . "/$key";
$job = jobRead($dir);
if ($job === null || ($job['status'] ?? '') !== 'queued') exit(0);   // nothing to do (already running / replaced)

// one worker per user directory
$lock = fopen("$dir/.lock", 'c');
if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) exit(0);

$children = [];   // running ffmpeg processes (proc_open handles)
$slot = null;

// the API kills a replaced/cancelled job with SIGTERM: stop the encoders and leave
pcntl_async_signals(true);
pcntl_signal(SIGTERM, function () use (&$children, $dir) {
    foreach ($children as $c) proc_terminate($c['proc'], SIGTERM);
    usleep(500000);
    foreach ($children as $c) if (proc_get_status($c['proc'])['running']) proc_terminate($c['proc'], SIGKILL);
    rmTree("$dir/work");
    @unlink("$dir/album.zip.part");
    exit(0);
});

$job['pid'] = getmypid();
$job['heartbeat'] = time();
jobWrite($dir, $job);

// expired downloads of all users (the only place that cleans up other users' directories)
downloadCleanup(null);

function fail(string $dir, array $job, string $msg): never {
    $job['status'] = 'error';
    $job['message'] = $msg;
    $job['finishedAt'] = time();
    $job['pid'] = null;
    jobWrite($dir, $job);
    rmTree("$dir/work");
    @unlink("$dir/album.zip.part");
    exit(1);
}

function beat(string $dir, array &$job): void {
    $job['heartbeat'] = time();
    jobWrite($dir, $job);
}

// ---- wait for a conversion slot (server-wide limit) ----
@mkdir(downloadRoot() . '/.slots', 02770, true);
while ($slot === null) {
    for ($i = 0; $i < DOWNLOAD_SLOTS; $i++) {
        $fp = fopen(downloadRoot() . "/.slots/$i", 'c');
        if ($fp !== false && flock($fp, LOCK_EX | LOCK_NB)) { $slot = $fp; break; }
        if ($fp !== false) fclose($fp);
    }
    if ($slot === null) { beat($dir, $job); sleep(3); }
}

$fmt = DOWNLOAD_FORMATS[$job['format']] ?? null;
$src = $job['srcDir'];
if ($fmt === null || !is_dir($src)) fail($dir, $job, 'album or format not found');

$work = "$dir/work";
rmTree($work);
if (!@mkdir($work, 02770, true)) fail($dir, $job, 'cannot create the work directory (run fix-perms.sh)');

$job['status'] = 'converting';
$job['tracksDone'] = 0;
beat($dir, $job);

// ---- cover: a small copy embedded into every converted file ----
$coverSmall = null;
if (!empty($job['coverFile']) && is_file($job['coverFile']) && $fmt['args'] !== null) {
    exec(sprintf('convert %s -auto-orient -resize 600x600\> -strip -quality 85 %s 2>/dev/null',
        escapeshellarg($job['coverFile']), escapeshellarg("$work/cover_small.jpg")), $o, $rc);
    if ($rc === 0 && is_file("$work/cover_small.jpg")) $coverSmall = "$work/cover_small.jpg";
}

// ---- output names ----
$ascii = (bool)$job['ascii'];
$albumDirName = safeName($job['title'] . ($job['year'] ? " ({$job['year']})" : ''), $ascii);
$artistDirName = safeName($job['artist'], $ascii);
$multiDisc = ($job['discs'] ?? 1) > 1;
$plan = [];   // [source, output in work/, name in the ZIP]
foreach ($job['tracks'] as $t) {
    $no = ($multiDisc ? $t['disc'] . '-' : '') . sprintf('%02d', $t['no']);
    $name = safeName("$no - " . $t['title'], $ascii) . '.' . $fmt['ext'];
    $plan[] = ['src' => "$src/{$t['file']}", 'out' => "$work/" . count($plan) . '.' . $fmt['ext'], 'name' => $name, 'label' => $t['title']];
}

// ---- convert (up to DOWNLOAD_PARALLEL ffmpeg processes) ----
if ($fmt['args'] === null) {
    // FLAC: the archive files are used as they are – nothing to convert
    foreach ($plan as &$p) $p['out'] = $p['src'];
    unset($p);
    $job['tracksDone'] = count($plan);
    beat($dir, $job);
} else {
    $queue = $plan;
    $lastBeat = time();
    $errors = [];
    while ($queue || $children) {
        while ($queue && count($children) < DOWNLOAD_PARALLEL) {
            $p = array_shift($queue);
            $cmd = 'ffmpeg -y -nostdin -loglevel error -i ' . escapeshellarg($p['src'])
                 . ($coverSmall ? ' -i ' . escapeshellarg($coverSmall) . ' -map 0:a:0 -map 1:v:0 -c:v copy -disposition:v attached_pic'
                                . ' -metadata:s:v title="Album cover" -metadata:s:v comment="Cover (front)"'
                                : ' -map 0:a:0')
                 . ' -map_metadata 0 ' . $fmt['args'] . ' ' . escapeshellarg($p['out']) . ' 2>&1';
            $proc = proc_open($cmd, [1 => ['pipe', 'w']], $pipes);
            if (!is_resource($proc)) fail($dir, $job, 'cannot start ffmpeg');
            stream_set_blocking($pipes[1], false);
            $children[] = ['proc' => $proc, 'pipe' => $pipes[1], 'p' => $p, 'log' => ''];
        }
        usleep(200000);
        foreach ($children as $i => $c) {
            $c['log'] .= (string)stream_get_contents($c['pipe']);
            $children[$i]['log'] = $c['log'];
            $st = proc_get_status($c['proc']);
            if ($st['running']) continue;
            fclose($c['pipe']);
            proc_close($c['proc']);
            unset($children[$i]);
            if ($st['exitcode'] !== 0 || !is_file($c['p']['out']) || filesize($c['p']['out']) === 0) {
                $errors[] = $c['p']['label'] . ': ' . trim($c['log'] ?: 'ffmpeg exit ' . $st['exitcode']);
                $queue = [];   // abort the rest
            }
            $job['tracksDone']++;
            $job['current'] = $c['p']['label'];
            beat($dir, $job);
            $lastBeat = time();
        }
        if ($errors && !$children) fail($dir, $job, 'conversion failed – ' . mb_substr($errors[0], 0, 300));
        if (time() - $lastBeat >= 15) { beat($dir, $job); $lastBeat = time(); }
    }
}

// ---- pack ----
$job['status'] = 'packing';
unset($job['current']);
beat($dir, $job);
$total = 0;
foreach ($plan as $p) $total += filesize($p['out']);
if ($total > DOWNLOAD_MAX_ZIP) fail($dir, $job, 'album is too large for a ZIP file (4 GB limit)');
$disk = @disk_free_space($dir);
if ($disk !== false && $disk < $total + 64 * 1024 * 1024) fail($dir, $job, 'not enough free disk space');

$zipName = downloadZipName($job);
$part = "$dir/album.zip.part";
try {
    $zip = new ZipWriter($part);
    $prefix = "$artistDirName/$albumDirName/";
    foreach ($plan as $p) $zip->addFile($p['out'], $prefix . $p['name']);
    if (!empty($job['coverFile']) && is_file($job['coverFile'])) {
        $zip->addFile($job['coverFile'], $prefix . 'cover.' . strtolower(pathinfo($job['coverFile'], PATHINFO_EXTENSION)));
    }
    $zip->close();
} catch (Throwable $e) {
    fail($dir, $job, $e->getMessage());
}
foreach (glob("$dir/*.zip") ?: [] as $old) @unlink($old);
if (!rename($part, "$dir/$zipName")) fail($dir, $job, 'cannot finish the ZIP file');
chmod("$dir/$zipName", 0660);
rmTree($work);

$job['status'] = 'ready';
$job['file'] = $zipName;
$job['size'] = filesize("$dir/$zipName");
$job['finishedAt'] = time();
$job['pid'] = null;
jobWrite($dir, $job);
