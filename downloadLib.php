<?php
// Album download: shared helpers for getData.php (API), auth.php (nginx
// auth_request) and download-worker.php (background conversion).
//
// A signed-in password user can have ONE prepared album at a time in
// tmp/<userKey>/ – a ZIP of the album in the chosen format (FLAC copy, ALAC,
// AAC, MP3). The state of the job lives in tmp/<userKey>/job.json, the
// conversion runs in a detached CLI worker (no cron, no daemon).

const DOWNLOAD_TTL_DAYS = 7;          // prepared ZIPs older than this are removed by the next worker run
const DOWNLOAD_SLOTS = 2;             // jobs converting at the same time (server-wide)
const DOWNLOAD_PARALLEL = 4;          // ffmpeg processes per job
const DOWNLOAD_HEARTBEAT_MAX = 90;    // seconds without heartbeat -> the job is considered dead
const DOWNLOAD_MAX_ZIP = 4294967295 - 64 * 1024 * 1024;   // no ZIP64: classic 4 GiB limit minus headroom
const DOWNLOAD_FORMATS = [
    // ext, ffmpeg codec arguments (null = copy the FLAC file), label
    'flac' => ['ext' => 'flac', 'args' => null,                                          'label' => 'FLAC'],
    'alac' => ['ext' => 'm4a',  'args' => '-c:a alac',                                  'label' => 'ALAC'],
    'aac'  => ['ext' => 'm4a',  'args' => '-c:a aac -b:a 256k',                         'label' => 'AAC'],
    'mp3'  => ['ext' => 'mp3',  'args' => '-c:a libmp3lame -q:a 0 -id3v2_version 3',   'label' => 'MP3'],
];
// estimated bitrate of the lossy formats (bits per second) for the size estimate
const DOWNLOAD_BITRATE = ['aac' => 256000, 'mp3' => 245000];

function downloadRoot(): string {
    return __DIR__ . '/tmp';
}

// Only password users may download – an IP auto-login ("@ip:…") or the
// no-config fallback ("@noconfig") is not an identity we can give a directory.
function downloadAllowed(?string $user): bool {
    return $user !== null && $user !== '' && $user[0] !== '@';
}

// tmp/<userKey>: "libor" -> "u-libor"; anything outside [A-Za-z0-9._-] becomes "_"
function downloadUserKey(string $user): string {
    $key = preg_replace('/[^A-Za-z0-9._-]/', '_', $user);
    return 'u-' . substr($key, 0, 60);
}

function downloadDir(string $user): string {
    return downloadRoot() . '/' . downloadUserKey($user);
}

// ---- job.json ----

function jobRead(string $dir): ?array {
    $json = @file_get_contents("$dir/job.json");
    if ($json === false) return null;
    $job = json_decode($json, true);
    return is_array($job) ? $job : null;
}

// atomic write (tmp + rename) so a reader never sees a half-written file
function jobWrite(string $dir, array $job): void {
    $tmp = "$dir/job.json.tmp";
    file_put_contents($tmp, json_encode($job, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    rename($tmp, "$dir/job.json");
}

function jobIsRunning(?array $job): bool {
    return $job !== null && in_array($job['status'] ?? '', ['queued', 'converting', 'packing'], true);
}

// a running job whose worker stopped reporting (crash, reboot, OOM)
function jobIsDead(?array $job): bool {
    if (!jobIsRunning($job)) return false;
    if (time() - (int)($job['heartbeat'] ?? 0) > DOWNLOAD_HEARTBEAT_MAX) return true;
    $pid = (int)($job['pid'] ?? 0);
    return $pid > 0 && function_exists('posix_kill') && !posix_kill($pid, 0);
}

// stops the worker of a running job (it cleans up its ffmpeg children itself)
function jobKill(?array $job): void {
    $pid = (int)($job['pid'] ?? 0);
    if ($pid > 0 && function_exists('posix_kill') && posix_kill($pid, 0)) {
        posix_kill($pid, SIGTERM);
        for ($i = 0; $i < 50 && posix_kill($pid, 0); $i++) usleep(100000);   // up to 5 s
    }
}

// removes a directory tree (the user's tmp/<userKey>/ or its work/ subdirectory)
function rmTree(string $dir): void {
    if (!is_dir($dir)) return;
    foreach (scandir($dir) as $f) {
        if ($f === '.' || $f === '..') continue;
        is_dir("$dir/$f") && !is_link("$dir/$f") ? rmTree("$dir/$f") : @unlink("$dir/$f");
    }
    @rmdir($dir);
}

// Removes finished jobs older than the TTL and leftovers without a job.json.
// Called by the worker at start and by the API for the user's own directory;
// running jobs of other users are never touched.
function downloadCleanup(?string $onlyKey = null, int $ttlDays = DOWNLOAD_TTL_DAYS): void {
    $root = downloadRoot();
    if (!is_dir($root)) return;
    $now = time();
    foreach (scandir($root) as $key) {
        if ($key[0] === '.' || !is_dir("$root/$key")) continue;
        if ($onlyKey !== null && $key !== $onlyKey) continue;
        $dir = "$root/$key";
        $job = jobRead($dir);
        if ($job === null) {
            if ($now - filemtime($dir) > 86400) rmTree($dir);   // orphan without job.json
            continue;
        }
        if (jobIsRunning($job) && !jobIsDead($job)) continue;
        $age = $now - (int)($job['finishedAt'] ?? $job['startedAt'] ?? filemtime($dir));
        if (jobIsDead($job) || $age > $ttlDays * 86400) rmTree($dir);
    }
}

// ---- names ----

// A file/directory name safe for Windows, macOS and FAT32: forbidden
// characters removed, trailing dots/spaces trimmed, optionally ASCII only.
function safeName(string $s, bool $ascii = false, int $max = 120): string {
    if ($ascii) {
        $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
        if ($t !== false && $t !== '') $s = $t;
        $s = preg_replace('/[^\x20-\x7E]/', '', $s);
    }
    $s = preg_replace('/[\/\\\\:*?"<>|\x00-\x1F\x7F]+/u', '', $s);
    $s = preg_replace('/\s+/u', ' ', $s);
    $s = trim($s, " .");
    if (mb_strlen($s) > $max) $s = rtrim(mb_substr($s, 0, $max), " .");
    return $s === '' ? '_' : $s;
}

// "Artist - Album (1997) [FLAC].zip"
function downloadZipName(array $job): string {
    $name = $job['artist'] . ' - ' . $job['title'] . ($job['year'] ? " ({$job['year']})" : '')
          . ' [' . DOWNLOAD_FORMATS[$job['format']]['label'] . ']';
    return safeName($name, (bool)$job['ascii'], 150) . '.zip';
}

// ---- ZIP writer (method 0 "Stored", UTF-8 names, no ZIP64) ----
// The server has neither the PHP zip extension nor a zip binary; audio does
// not compress anyway, so storing is the right method – every unzip tool
// (Explorer, macOS, 7-Zip, unzip, Android, iOS) reads it.
class ZipWriter {
    private $fp;
    private array $central = [];
    private int $offset = 0;

    public function __construct(string $path) {
        $this->fp = fopen($path, 'wb');
        if ($this->fp === false) throw new RuntimeException("cannot create $path");
    }

    // DOS date/time (2-second resolution, years from 1980)
    private static function dosTime(int $ts): array {
        $y = (int)date('Y', $ts); if ($y < 1980) $y = 1980;
        $time = ((int)date('H', $ts) << 11) | ((int)date('i', $ts) << 5) | ((int)date('s', $ts) >> 1);
        $date = (($y - 1980) << 9) | ((int)date('n', $ts) << 5) | (int)date('j', $ts);
        return [$time, $date];
    }

    // adds a file from disk under the given archive name ("Artist/Album/01 - Title.flac")
    public function addFile(string $path, string $name): void {
        $size = filesize($path);
        if ($size === false) throw new RuntimeException("cannot read $path");
        if ($this->offset + $size + 1024 + strlen($name) > DOWNLOAD_MAX_ZIP) throw new RuntimeException('album is too large for a ZIP file (4 GB limit)');
        $crc = hexdec(hash_file('crc32b', $path));
        [$time, $date] = self::dosTime(filemtime($path) ?: time());
        $name = str_replace('\\', '/', $name);

        // local file header: sig, version needed (2.0), flags (bit 11 = UTF-8), method 0,
        // time, date, crc, compressed size, uncompressed size, name length, extra length
        $local = pack('VvvvvvVVVvv', 0x04034b50, 20, 0x0800, 0, $time, $date, $crc, $size, $size, strlen($name), 0) . $name;
        $this->write($local);
        $in = fopen($path, 'rb');
        if ($in === false) throw new RuntimeException("cannot read $path");
        $copied = stream_copy_to_stream($in, $this->fp);
        fclose($in);
        if ($copied !== $size) throw new RuntimeException("short read on $path");

        // central directory entry: sig, version made by (UNIX, 2.0), version needed, flags, method,
        // time, date, crc, sizes, name len, extra len, comment len, disk, int attrs, ext attrs (0644 file), offset
        $this->central[] = pack('VvvvvvvVVVvvvvvVV', 0x02014b50, 0x031e, 20, 0x0800, 0, $time, $date, $crc, $size, $size,
                                strlen($name), 0, 0, 0, 0, (0100644 << 16), $this->offset) . $name;
        $this->offset += strlen($local) + $size;
    }

    private function write(string $data): void {
        if (fwrite($this->fp, $data) !== strlen($data)) throw new RuntimeException('write failed (disk full?)');
    }

    public function close(): void {
        $cdStart = $this->offset;
        $cd = implode('', $this->central);
        $this->write($cd);
        // end of central directory: sig, disk, cd disk, entries on disk, entries total, cd size, cd offset, comment len
        $n = count($this->central);
        $this->write(pack('VvvvvVVv', 0x06054b50, 0, 0, $n, $n, strlen($cd), $cdStart, 0));
        fclose($this->fp);
    }
}
