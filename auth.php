<?php
// Internal endpoint for nginx auth_request – protects static music files
// (audio files, covers and prepared downloads). 204 = allow, 403 = deny.
session_name('userSession');   // instead of the generic PHPSESSID (the domain is shared with other apps)
session_start();
require __DIR__ . '/authLib.php';
require __DIR__ . '/downloadLib.php';

$config = json_decode(@file_get_contents(__DIR__ . '/config.json'), true);
$user = resolveAuthUser(is_array($config) ? $config : null);
session_write_close();   // release the session lock quickly – images load in parallel

$allow = $user !== null;

// tmp/<userKey>/<file>.zip – a prepared download belongs to one password user;
// nginx passes the requested URL in X_ORIGINAL_URI (see README, nginx snippet)
$uri = rawurldecode((string)($_SERVER['X_ORIGINAL_URI'] ?? ''));
if (preg_match('~/tmp/([^/]+)/([^/]+)$~', strtok($uri, '?'), $m)) {
    $allow = $allow && downloadAllowed($user) && $m[1] === downloadUserKey($user) && str_ends_with($m[2], '.zip');
}

http_response_code($allow ? 204 : 403);
