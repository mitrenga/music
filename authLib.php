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

    // automatic sign-in by IP
    if ($user === null && ipMatches($clientIp, array_column(autoLoginEntries($config), 'ip'))) {
        $_SESSION['user'] = $user = '@ip:' . $clientIp;
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
