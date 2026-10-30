<?php
// A small message board for the lobby (web/board.js), so finding rooms needs no third-party server:
// - the public games list: "kept" messages, the latest per topic (rooms/<code>), for 30 seconds;
// - setting up connections between players (WebRTC signalling): short-lived messages on topics,
//   fetched by polling.
//
//   GET  board.php?since=-1                     -> {"last": <id>}  (where to start polling)
//   GET  board.php?t=<topic>,<topic>&since=<id> -> {"last": <id>, "msgs": [{"id", "t", "m"}]}
//   GET  board.php?kept=<prefix>                -> {"kept": [{"t", "m"}]}
//   POST board.php {"t": <topic>, "m": <text>, "keep": true|false}   (keep with m "" removes)
//
// Everything lives in one small file in the system's temporary folder, under a lock. Nothing is
// kept for long: messages for a minute, kept ones for 30 seconds after their last update.

header('Content-Type: application/json');
header('Cache-Control: no-store');

const MSG_TTL = 60;
const KEPT_TTL = 30;
const MAX_MSGS = 3000; // (each page in a room says it is there every 4 seconds: web/board.js)
const MAX_KEPT = 200;
const MAX_TEXT = 20000;
const TOPIC = '/^[A-Za-z0-9_.:\/-]{1,160}$/';

function fail($code, $text) {
    http_response_code($code);
    echo json_encode(['error' => $text]);
    exit;
}

$file = sys_get_temp_dir() . '/gta2web-board-' . md5(__DIR__) . '.json';
$fh = fopen($file, 'c+');
if (!$fh || !flock($fh, LOCK_EX)) fail(500, 'board unavailable');
$raw = stream_get_contents($fh);
$db = $raw ? json_decode($raw, true) : null;
if (!is_array($db)) $db = ['last' => 0, 'msgs' => [], 'kept' => []];

$now = time();
$db['msgs'] = array_values(array_filter($db['msgs'], function ($m) use ($now) { return $now - $m['at'] < MSG_TTL; }));
$db['kept'] = array_filter($db['kept'], function ($k) use ($now) { return $now - $k['at'] < KEPT_TTL; });
$changed = false;
$out = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $in = json_decode(file_get_contents('php://input', false, null, 0, MAX_TEXT + 1000), true);
    if (!is_array($in) || !is_string($in['t'] ?? null) || !is_string($in['m'] ?? null)) fail(400, 'bad message');
    if (!preg_match(TOPIC, $in['t']) || strlen($in['m']) > MAX_TEXT) fail(400, 'bad message');
    if (!empty($in['keep'])) {
        if ($in['m'] === '') unset($db['kept'][$in['t']]);
        elseif (count($db['kept']) < MAX_KEPT || isset($db['kept'][$in['t']])) $db['kept'][$in['t']] = ['m' => $in['m'], 'at' => $now];
    } else {
        $db['msgs'][] = ['id' => ++$db['last'], 't' => $in['t'], 'm' => $in['m'], 'at' => $now];
        if (count($db['msgs']) > MAX_MSGS) $db['msgs'] = array_slice($db['msgs'], -MAX_MSGS);
    }
    $changed = true;
    $out = ['ok' => true];
} elseif (isset($_GET['kept'])) {
    $prefix = (string)$_GET['kept'];
    $kept = [];
    foreach ($db['kept'] as $t => $k) if (strpos($t, $prefix) === 0) $kept[] = ['t' => $t, 'm' => $k['m']];
    $out = ['kept' => $kept];
} else {
    $since = (int)($_GET['since'] ?? -1);
    $out = ['last' => $db['last']];
    if ($since >= 0) {
        $topics = array_slice(array_filter(explode(',', (string)($_GET['t'] ?? '')), function ($t) { return preg_match(TOPIC, $t); }), 0, 40);
        $want = array_flip($topics);
        $msgs = [];
        foreach ($db['msgs'] as $m) if ($m['id'] > $since && isset($want[$m['t']])) $msgs[] = ['id' => $m['id'], 't' => $m['t'], 'm' => $m['m']];
        $out['msgs'] = $msgs;
    }
}

if ($changed || $raw === '' || $raw === false) {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($db));
    fflush($fh);
}
flock($fh, LOCK_UN);
fclose($fh);
echo json_encode($out);
