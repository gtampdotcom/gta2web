<?php
// TURN relay servers for the lobby's WebRTC connections (web/net.js asks for them when joining a
// room). Most players connect directly; players on networks that block that (some mobile carriers,
// company and school networks, strict routers) only connect through a relay.
//
//   GET turn.php -> {"iceServers": [{"urls": [...], "username": "...", "credential": "..."}, ...]}
//
// Configure it with turn-config.php next to this file (keep it out of the site's source: it holds
// secrets). No file: no relays, players connect directly as before. One or more of:
//
//   <?php return [
//     // Cloudflare Realtime TURN (dash.cloudflare.com > Realtime > TURN): a TURN key's ID and API token
//     'cloudflare' => ['key_id' => '...', 'api_token' => '...'],
//     // Metered (metered.ca): the app's name (<name>.metered.live) and a TURN credentials API key
//     'metered' => ['app' => '...', 'api_key' => '...'],
//     // your own TURN server, for example coturn with use-auth-secret and static-auth-secret=<secret>:
//     // short-lived logins are made here from the shared secret
//     'servers' => [
//       ['urls' => ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], 'secret' => '...'],
//       // or a fixed login
//       ['urls' => ['turn:relay.example.com:3478'], 'username' => '...', 'credential' => '...'],
//     ],
//     'ttl' => 21600, // seconds a login lasts (6 hours; Cloudflare and shared-secret logins)
//   ];
//
// Anyone who loads the site can get a login, as with any public TURN set-up: keep the time short,
// and watch the provider's usage.

declare(strict_types=1);

header('Content-Type: application/json');
header('Cache-Control: no-store');

$config = is_file(__DIR__ . '/turn-config.php') ? (include __DIR__ . '/turn-config.php') : null;
if (!is_array($config)) {
    echo json_encode(['iceServers' => []]);
    exit;
}
$ttl = max(300, (int)($config['ttl'] ?? 21600));
$servers = [];

/** A POST or GET to a provider's API: its JSON, or null. */
function fetch_json(string $url, string $method = 'GET', array $headers = [], ?string $body = null): ?array {
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5, CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        $text = curl_exec($ch);
        $ok = curl_getinfo($ch, CURLINFO_RESPONSE_CODE) < 300;
        curl_close($ch);
    } else {
        $context = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $headers),
            'content' => $body ?? '', 'timeout' => 5, 'ignore_errors' => true]]);
        $text = @file_get_contents($url, false, $context);
        $ok = isset($http_response_header[0]) && preg_match('/ 2\d\d /', $http_response_header[0]);
    }
    $data = $ok && is_string($text) ? json_decode($text, true) : null;
    return is_array($data) ? $data : null;
}

/** Only well-formed ICE server entries (urls: stun:, turn: or turns:). */
function clean_servers($list): array {
    $out = [];
    foreach (is_array($list) ? $list : [] as $s) {
        if (!is_array($s)) continue;
        $urls = array_values(array_filter((array)($s['urls'] ?? $s['url'] ?? []),
            function ($u) { return is_string($u) && preg_match('/^(stun|turns?):/', $u); }));
        if (!$urls) continue;
        $entry = ['urls' => $urls];
        if (isset($s['username'], $s['credential'])) {
            $entry['username'] = (string)$s['username'];
            $entry['credential'] = (string)$s['credential'];
        }
        $out[] = $entry;
    }
    return $out;
}

$cf = $config['cloudflare'] ?? null;
if (is_array($cf) && !empty($cf['key_id']) && !empty($cf['api_token'])) {
    $data = fetch_json('https://rtc.live.cloudflare.com/v1/turn/keys/' . rawurlencode((string)$cf['key_id']) . '/credentials/generate',
        'POST', ['Authorization: Bearer ' . $cf['api_token'], 'Content-Type: application/json'], json_encode(['ttl' => $ttl]));
    $ice = $data['iceServers'] ?? null;
    $servers = array_merge($servers, clean_servers(isset($ice['urls']) ? [$ice] : $ice));
}

$metered = $config['metered'] ?? null;
if (is_array($metered) && !empty($metered['app']) && !empty($metered['api_key']) && preg_match('/^[A-Za-z0-9-]+$/', (string)$metered['app'])) {
    $servers = array_merge($servers, clean_servers(fetch_json('https://' . $metered['app'] . '.metered.live/api/v1/turn/credentials?apiKey='
        . rawurlencode((string)$metered['api_key']))));
}

foreach (is_array($config['servers'] ?? null) ? $config['servers'] : [] as $s) {
    if (is_array($s) && !empty($s['secret'])) {
        // the TURN REST API login (coturn use-auth-secret): "<expiry>:<name>", HMAC-SHA1 of it with the secret
        $username = (time() + $ttl) . ':gta2web';
        $s['username'] = $username;
        $s['credential'] = base64_encode(hash_hmac('sha1', $username, (string)$s['secret'], true));
    }
    $servers = array_merge($servers, clean_servers([$s]));
}

echo json_encode(['iceServers' => $servers]);
