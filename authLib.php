<?php
// Shared authentication for getData.php and auth.php (nginx auth_request).
// Expects an already started session (session_start).

function ipMatches(string $ip, array $list): bool {
    foreach ($list as $allowed) {
        if (str_contains($allowed, '/')) {          // CIDR, e.g. 10.25.0.0/16
            [$net, $bits] = explode('/', $allowed, 2);
            $ipBin = @inet_pton($ip);
            $netBin = @inet_pton($net);
            if ($ipBin === false || $netBin === false || strlen($ipBin) !== strlen($netBin)) continue;
            $bits = (int)$bits;
            $bytes = intdiv($bits, 8);
            $rem = $bits % 8;
            if (substr($ipBin, 0, $bytes) !== substr($netBin, 0, $bytes)) continue;
            if ($rem === 0 || ((ord($ipBin[$bytes]) ^ ord($netBin[$bytes])) & (0xFF << (8 - $rem)) & 0xFF) === 0) return true;
        } elseif ($ip === $allowed) {
            return true;
        }
    }
    return false;
}

// autoLoginIps entries are either plain strings ("10.0.0.0/16") or objects
// with permissions ({"ip": "10.0.0.0/16", "rights": ["move"]}); this
// normalizes both forms to [['ip' => ..., 'rights' => [...]], ...]
function autoLoginEntries(?array $config): array {
    $entries = [];
    foreach (($config['autoLoginIps'] ?? []) as $e) {
        if (is_string($e)) {
            $entries[] = ['ip' => $e, 'rights' => []];
        } elseif (is_array($e) && is_string($e['ip'] ?? null)) {
            $rights = array_values(array_filter((array)($e['rights'] ?? []), 'is_string'));
            $entries[] = ['ip' => $e['ip'], 'rights' => $rights];
        }
    }
    return $entries;
}

// ---- passwords ----
// A password lives either on the user's entry in config.json, or – when the
// config has "sharedPasswords": "<file>" – in that file, shared by several
// installs (galleries, music archives) so that one password works in all of
// them. config.json still decides who may sign in here and with what rights;
// the shared file only holds the password:
//   { "name": { "password": "..." }, ... }
// A stored password is a password_hash() value, or plain text (as written by
// hand). With "sharedPasswords" set, "password" keys in config.json are
// ignored, and a missing/unreadable file or a user missing in it means that
// password sign-in is refused (it never falls back to "nothing is locked").

// Path of the shared password file, or null when the config does not use one.
// A relative path is taken from the application directory.
function sharedPasswordsFile(?array $config): ?string {
    $file = $config['sharedPasswords'] ?? null;
    if (!is_string($file) || $file === '') return null;
    return $file[0] === '/' ? $file : __DIR__ . '/' . $file;
}

// Reads the shared password file; null when it is missing or broken. Cached
// for the request – auth.php may need it several times.
function loadSharedPasswords(string $file, bool $fresh = false): ?array {
    static $cache = [];
    if (!$fresh && array_key_exists($file, $cache)) return $cache[$file];
    $data = null;
    $fh = is_file($file) ? @fopen($file, 'r') : false;
    if ($fh !== false) {
        flock($fh, LOCK_SH);   // never read a half-written file
        $data = json_decode((string)stream_get_contents($fh), true);
        flock($fh, LOCK_UN);
        fclose($fh);
    }
    return $cache[$file] = is_array($data) ? $data : null;
}

// The stored password (hash or plain text) of a user listed in the config;
// null when the user is not listed or has no usable password.
function storedPassword(?array $config, string $user): ?string {
    foreach (($config['users'] ?? []) as $usr) {
        if (($usr['user'] ?? null) !== $user) continue;
        $file = sharedPasswordsFile($config);
        if ($file === null) {
            $stored = $usr['password'] ?? null;
        } else {
            $stored = loadSharedPasswords($file)[$user]['password'] ?? null;
        }
        return is_string($stored) && $stored !== '' ? $stored : null;
    }
    return null;
}

function isPasswordHash(string $stored): bool {
    return password_get_info($stored)['algo'] !== null;
}

// Checks a sign-in attempt. A plain-text password (in the shared file or in
// config.json) is replaced by its hash on the first successful sign-in.
function verifyPassword(string $configFile, ?array $config, string $user, string $password): bool {
    $stored = storedPassword($config, $user);
    if ($stored === null || $password === '') return false;
    $file = sharedPasswordsFile($config);
    if (isPasswordHash($stored)) {
        if (!password_verify($password, $stored)) return false;
        $upgrade = password_needs_rehash($stored, PASSWORD_DEFAULT);
    } else {
        if (!hash_equals($stored, $password)) return false;
        $upgrade = true;
    }
    // best effort – when the file is not writable the plain password simply stays
    if ($upgrade && ($file !== null || is_writable($configFile))) {
        savePassword($configFile, $config, $user, $password);
    }
    return true;
}

// Stores the hash of a new password in the shared file. Read + change + write
// happen under one exclusive lock, because several installs write this file.
// The file must already exist – a mistyped path must not create a new one.
function writeSharedPassword(string $file, string $user, string $password): bool {
    $fh = is_file($file) ? @fopen($file, 'r+') : false;   // r+ follows a symlink and keeps it
    if ($fh === false) return false;
    flock($fh, LOCK_EX);
    $data = json_decode((string)stream_get_contents($fh), true);
    $ok = false;
    if (is_array($data)) {
        if (!is_array($data[$user] ?? null)) $data[$user] = [];
        $data[$user]['password'] = password_hash($password, PASSWORD_DEFAULT);
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
        $ok = rewind($fh) && ftruncate($fh, 0) && fwrite($fh, $json) === strlen($json) && fflush($fh);
    }
    flock($fh, LOCK_UN);
    fclose($fh);
    loadSharedPasswords($file, true);   // refresh the request cache
    return $ok;
}

// Stores the hash of a password (password reset, or the upgrade of a plain
// password on sign-in) for a user listed in the config – in the shared file
// when one is configured, otherwise in config.json.
function savePassword(string $configFile, ?array $config, string $user, string $password): bool {
    foreach (($config['users'] ?? []) as $i => $usr) {
        if (($usr['user'] ?? null) !== $user) continue;
        $file = sharedPasswordsFile($config);
        if ($file !== null) return writeSharedPassword($file, $user, $password);
        $config['users'][$i]['password'] = password_hash($password, PASSWORD_DEFAULT);
        return file_put_contents($configFile,
            json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            LOCK_EX) !== false;
    }
    return false;
}

// ---- persistent login ("remember me") ----
// After a password login a signed cookie keeps the user signed in even after
// the PHP session expires. Browsers cap cookie lifetime at ~400 days, so the
// cookie is re-issued on every request – it never expires while the app is
// visited at least once in REMEMBER_DAYS. The signature key is
// derived from the user's password, so changing the password (or deleting the
// user) invalidates all their cookies – no extra secret file is needed.
const REMEMBER_COOKIE = 'userRemember';
const REMEMBER_DAYS = 400;

function rememberKey(?array $config, string $user): ?string {
    $stored = storedPassword($config, $user);
    return $stored === null ? null : hash_hmac('sha256', $stored, 'remember:' . __DIR__);
}

function rememberCookieOptions(int $expires): array {
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    $path = rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/') . '/';
    return ['expires' => $expires, 'path' => $path, 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax'];
}

function setRememberCookie(?array $config, string $user): void {
    $key = rememberKey($config, $user);
    if ($key === null) return;
    $expires = time() + REMEMBER_DAYS * 86400;
    $payload = base64_encode($user) . '.' . $expires;
    $token = $payload . '.' . hash_hmac('sha256', $payload, $key);
    setcookie(REMEMBER_COOKIE, $token, rememberCookieOptions($expires));
}

function clearRememberCookie(): void {
    if (isset($_COOKIE[REMEMBER_COOKIE])) setcookie(REMEMBER_COOKIE, '', rememberCookieOptions(1));
}

// Validates the remember cookie; returns the user name or null.
function userFromRememberCookie(?array $config): ?string {
    $token = $_COOKIE[REMEMBER_COOKIE] ?? '';
    $parts = explode('.', $token);
    if (count($parts) !== 3) return null;
    [$b64, $expires, $sig] = $parts;
    $user = base64_decode($b64, true);
    if ($user === false || $user === '' || !ctype_digit($expires) || (int)$expires < time()) return null;
    $key = rememberKey($config, $user);
    if ($key === null) return null;
    return hash_equals(hash_hmac('sha256', "$b64.$expires", $key), $sig) ? $user : null;
}

// Returns the signed-in user name, or null. The session is re-validated on
// every request: removing an IP or deleting a user in the config takes effect
// immediately.
function resolveAuthUser(?array $config): ?string {
    $clientIp = $_SERVER['REMOTE_ADDR'] ?? '';

    // without a config file nothing is locked (safeguard against a path typo)
    if ($config === null) {
        $_SESSION['user'] = $_SESSION['user'] ?? '@noconfig';
        return $_SESSION['user'];
    }

    $user = $_SESSION['user'] ?? null;

    // an auto-login session stays valid only while the IP is in the config
    if ($user !== null && str_starts_with($user, '@ip:')
            && !ipMatches($clientIp, array_column(autoLoginEntries($config), 'ip'))) {
        unset($_SESSION['user']);
        $user = null;
    }

    // a password-authenticated user must still exist in the config
    if ($user !== null && !str_starts_with($user, '@')) {
        $exists = false;
        foreach (($config['users'] ?? []) as $usr) {
            if ($usr['user'] === $user) { $exists = true; break; }
        }
        if (!$exists) {
            unset($_SESSION['user']);
            $user = null;
        }
    }

    // persistent login cookie (set after a password login)
    if ($user === null && ($remembered = userFromRememberCookie($config)) !== null) {
        $_SESSION['user'] = $user = $remembered;
    }

    // automatic sign-in by IP
    if ($user === null && ipMatches($clientIp, array_column(autoLoginEntries($config), 'ip'))) {
        $_SESSION['user'] = $user = '@ip:' . $clientIp;
    }

    // sliding expiry: renew the persistent cookie of a password user
    if ($user !== null && !str_starts_with($user, '@') && isset($_COOKIE[REMEMBER_COOKIE]) && !headers_sent()) {
        setRememberCookie($config, $user);
    }

    return $user;
}

// Permissions ("rights") of the signed-in user: password users have them on
// their entry in "users", IP auto-logins on the matching "autoLoginIps"
// entry. No "rights" key in the config means no permissions.
function resolveRights(?array $config, ?string $user): array {
    if ($user === null) return [];
    if ($config === null) return ['move', 'delete', 'cover'];   // @noconfig – nothing is locked

    if (str_starts_with($user, '@ip:')) {
        $ip = substr($user, 4);
        foreach (autoLoginEntries($config) as $e) {
            if (ipMatches($ip, [$e['ip']])) return $e['rights'];   // first matching entry wins
        }
        return [];
    }

    foreach (($config['users'] ?? []) as $usr) {
        if ($usr['user'] === $user) {
            return array_values(array_filter((array)($usr['rights'] ?? []), 'is_string'));
        }
    }
    return [];
}
