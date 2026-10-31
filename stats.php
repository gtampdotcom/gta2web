<?php
// The site's own play counts (web/stats.js), kept on this server instead of (or as well as)
// GoatCounter, and the history of hosted co-op matches: when, which map, which mode, how many
// players and the host's country. No addresses or names are stored.
//
//   POST stats.php {"p": "play/solo"}                                  count one event
//   POST stats.php {"p": "map/<id>", "match": {"map", "mode", "players"}}  ... and record a match
//   GET  stats.php?ping                                                {"stats": true} (whether this site has it)
//   GET  stats.php?json                                                the counts and history as JSON
//   GET  stats.php                                                     the same as a page
//
// The host's country comes from the web server, never from a third party: Cloudflare's
// CF-IPCountry header, a GeoIP module (GEOIP_COUNTRY_CODE, MM_COUNTRY_CODE, X-Country-Code) or
// PHP's geoip extension. Without any of those, the browser's language region is used, marked
// as a guess. Everything lives in stats-data.php next to this file (it starts with an exit, so
// the web server never shows it).

declare(strict_types=1);

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const DATA = __DIR__ . '/stats-data.php';
const GUARD = "<?php exit; ?>\n";
const PATH = '/^\/?[a-z0-9_.\/-]{1,80}$/';
const MAX_PATHS = 3000;
const MAX_HISTORY = 5000;
const DAYS = 90;
const MODES = ['roam', 'wars', 'ffa', 'points', 'tag'];

function json_out($data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function h(string $s): string {
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** The maps a match can be on: the original game's and the community maps (maps/maps.json). */
function map_labels(): array {
    $labels = ['downtown' => 'Downtown', 'residential' => 'Residential', 'industrial' => 'Industrial',
        'tinytown' => 'Tiny Town', 'hiddensurprise' => 'Hidden Surprise', 'faceoff' => 'Face Off'];
    $list = json_decode((string)@file_get_contents(__DIR__ . '/maps/maps.json'), true);
    foreach (($list['maps'] ?? []) as $m) {
        if (is_string($m['id'] ?? null) && is_string($m['label'] ?? null)) $labels[$m['id']] = $m['label'];
    }
    return $labels;
}

/** [two-letter country code or '', true when it is only the browser's language region]. */
function host_country(): array {
    $server = [
        $_SERVER['HTTP_CF_IPCOUNTRY'] ?? '', $_SERVER['GEOIP_COUNTRY_CODE'] ?? '',
        $_SERVER['MM_COUNTRY_CODE'] ?? '', $_SERVER['HTTP_X_COUNTRY_CODE'] ?? '',
    ];
    if (function_exists('geoip_country_code_by_name') && !empty($_SERVER['REMOTE_ADDR'])) {
        $server[] = (string)@geoip_country_code_by_name($_SERVER['REMOTE_ADDR']);
    }
    foreach ($server as $c) {
        $c = strtoupper(trim((string)$c));
        if (preg_match('/^[A-Z]{2}$/', $c) && !in_array($c, ['XX', 'T1', 'ZZ'], true)) return [$c, false];
    }
    // e.g. "pt-BR,pt;q=0.9" -> BR
    if (preg_match('/^[a-z]{2,3}[-_]([A-Za-z]{2})\b/', (string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''), $m)) {
        return [strtoupper($m[1]), true];
    }
    return ['', false];
}

function flag(string $code): string {
    if (!preg_match('/^[A-Z]{2}$/', $code)) return '';
    return mb_chr(0x1F1E6 + ord($code[0]) - 65) . mb_chr(0x1F1E6 + ord($code[1]) - 65);
}

/** Opens the data file under a lock and returns [handle, data]. */
function open_data(): array {
    $fh = fopen(DATA, 'c+');
    if (!$fh || !flock($fh, LOCK_EX)) json_out(['error' => 'stats unavailable'], 500);
    $raw = (string)stream_get_contents($fh);
    $db = json_decode(substr($raw, strlen(GUARD)), true);
    if (!is_array($db)) $db = [];
    $db += ['since' => gmdate('c'), 'counts' => [], 'days' => [], 'history' => []];
    return [$fh, $db];
}

function close_data($fh, ?array $db): void {
    if ($db !== null) {
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, GUARD . json_encode($db, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        fflush($fh);
    }
    flock($fh, LOCK_UN);
    fclose($fh);
}

// ---------------------------------------------------------------- counting

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $in = json_decode((string)file_get_contents('php://input', false, null, 0, 4096), true);
    $path = is_array($in) && is_string($in['p'] ?? null) ? strtolower($in['p']) : '';
    if (!preg_match(PATH, $path)) json_out(['error' => 'bad path'], 400);
    $match = null;
    if (is_array($in['match'] ?? null)) {
        $labels = map_labels();
        $map = (string)($in['match']['map'] ?? '');
        $mode = (string)($in['match']['mode'] ?? '');
        $players = (int)($in['match']['players'] ?? 0);
        if (!isset($labels[$map]) || !in_array($mode, MODES, true) || $players < 1 || $players > 16) json_out(['error' => 'bad match'], 400);
        [$country, $guess] = host_country();
        $match = ['at' => gmdate('c'), 'map' => $map, 'label' => $labels[$map], 'mode' => $mode, 'players' => $players,
            'country' => $country] + ($guess ? ['guess' => true] : []);
    }
    [$fh, $db] = open_data();
    if (isset($db['counts'][$path]) || count($db['counts']) < MAX_PATHS) $db['counts'][$path] = ($db['counts'][$path] ?? 0) + 1;
    $day = gmdate('Y-m-d');
    $db['days'][$day] = ($db['days'][$day] ?? 0) + 1;
    ksort($db['days']);
    $db['days'] = array_slice($db['days'], -DAYS, null, true);
    if ($match) {
        $db['history'][] = $match;
        if (count($db['history']) > MAX_HISTORY) $db['history'] = array_slice($db['history'], -MAX_HISTORY);
    }
    close_data($fh, $db);
    json_out(['ok' => true]);
}

if (isset($_GET['ping'])) json_out(['stats' => true]);

[$fh, $db] = open_data();
close_data($fh, null);
arsort($db['counts']);

if (isset($_GET['json'])) json_out($db);

// ---------------------------------------------------------------- the page

$total = function (string $prefix) use ($db): int {
    $n = 0;
    foreach ($db['counts'] as $p => $c) if (strpos($p, $prefix) === 0) $n += $c;
    return $n;
};
$maps = [];
$countries = [];
foreach ($db['history'] as $m) {
    $maps[$m['label']] = ($maps[$m['label']] ?? 0) + 1;
    $key = $m['country'] !== '' ? $m['country'] : '?';
    $countries[$key] = ($countries[$key] ?? 0) + 1;
}
arsort($maps);
arsort($countries);
$history = array_reverse($db['history']);
$per = 100;
$pages = max(1, (int)ceil(count($history) / $per));
$page = min($pages, max(1, (int)($_GET['page'] ?? 1)));
$rows = array_slice($history, ($page - 1) * $per, $per);
$modeName = ['roam' => 'Free Roam', 'wars' => 'Gang Wars', 'ffa' => 'Frag Game', 'points' => 'Points Game', 'tag' => 'Tag Game'];
$region = function_exists('locale_get_display_region');
$countryName = function (string $c) use ($region): string {
    if ($c === '' || $c === '?') return 'Unknown';
    $name = $region ? (locale_get_display_region("-$c", 'en') ?: $c) : $c;
    return '<span data-country="' . h($c) . '">' . h($name) . '</span>';
};

header('Content-Type: text/html; charset=utf-8');
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GTA2 play stats</title>
<style>
:root{--bg:#0e0e12;--panel:#16161a;--line:#2a2a31;--text:#eee;--dim:#999;--accent:#d8452e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}h1{margin:0 0 4px}h2{margin:32px 0 10px;font-size:18px}
.dim{color:var(--dim)}a{color:#ff8a7a}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:18px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px}
.tile b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.tile span{color:var(--dim);font-size:13px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--dim);font-weight:600;font-size:13px}
td.n{text-align:right}.bar{height:6px;background:var(--accent);border-radius:3px;min-width:2px}
.pager{display:flex;gap:12px;margin-top:12px}
</style></head><body><main>
<h1>GTA2 play stats</h1>
<p class="dim">Counted on this server since <time datetime="<?= h($db['since']) ?>"><?= h(substr($db['since'], 0, 10)) ?></time>. No addresses or names are kept.</p>
<div class="tiles">
  <div class="tile"><b><?= number_format($db['counts']['/'] ?? 0) ?></b><span>front page visits</span></div>
  <div class="tile"><b><?= number_format($total('play/solo')) ?></b><span>solo games</span></div>
  <div class="tile"><b><?= number_format($total('play/coop')) ?></b><span>co-op games joined</span></div>
  <div class="tile"><b><?= number_format(count($db['history'])) ?></b><span>matches hosted</span></div>
  <div class="tile"><b><?= number_format($db['counts']['download/gta2'] ?? 0) ?></b><span>game downloads</span></div>
</div>

<div class="cols">
<section><h2>Most hosted maps</h2>
<?php if (!$maps): ?><p class="dim">No matches hosted yet.</p><?php else: $top = max($maps); ?>
<table><tr><th>Map</th><th></th><th class="n">Matches</th></tr>
<?php foreach (array_slice($maps, 0, 20, true) as $label => $n): ?>
<tr><td><?= h((string)$label) ?></td><td style="width:40%"><div class="bar" style="width:<?= round($n / $top * 100) ?>%"></div></td><td class="n"><?= $n ?></td></tr>
<?php endforeach ?></table><?php endif ?>
</section>
<section><h2>Hosts by country</h2>
<?php if (!$countries): ?><p class="dim">No matches hosted yet.</p><?php else: $top = max($countries); ?>
<table><tr><th>Country</th><th></th><th class="n">Matches</th></tr>
<?php foreach (array_slice($countries, 0, 20, true) as $c => $n): ?>
<tr><td><?= flag((string)$c) ?> <?= $countryName((string)$c) ?></td><td style="width:40%"><div class="bar" style="width:<?= round($n / $top * 100) ?>%"></div></td><td class="n"><?= $n ?></td></tr>
<?php endforeach ?></table><?php endif ?>
</section>
</div>

<h2>Hosted matches</h2>
<?php if (!$rows): ?><p class="dim">No matches hosted yet.</p><?php else: ?>
<div class="scroll"><table>
<tr><th>When</th><th>Map</th><th>Mode</th><th class="n">Players</th><th>Host country</th></tr>
<?php foreach ($rows as $m): ?>
<tr><td><time datetime="<?= h($m['at']) ?>"><?= h(str_replace('T', ' ', substr($m['at'], 0, 16))) ?> UTC</time></td>
<td><?= h($m['label']) ?></td><td><?= h($modeName[$m['mode']] ?? $m['mode']) ?></td><td class="n"><?= (int)$m['players'] ?></td>
<td><?= flag($m['country']) ?> <?= $countryName($m['country']) ?><?= !empty($m['guess']) ? ' <span class="dim" title="From the browser language, not the address">(guess)</span>' : '' ?></td></tr>
<?php endforeach ?>
</table></div>
<?php if ($pages > 1): ?><p class="pager">
<?php if ($page > 1): ?><a href="?page=<?= $page - 1 ?>">Newer</a><?php endif ?>
<span class="dim">Page <?= $page ?> of <?= $pages ?></span>
<?php if ($page < $pages): ?><a href="?page=<?= $page + 1 ?>">Older</a><?php endif ?></p><?php endif ?>
<?php endif ?>

<h2>All counts</h2>
<div class="scroll"><table><tr><th>What</th><th class="n">Count</th></tr>
<?php foreach ($db['counts'] as $p => $n): ?><tr><td><?= h((string)$p) ?></td><td class="n"><?= number_format($n) ?></td></tr><?php endforeach ?>
</table></div>
</main>
<script>
// times in the viewer's own time zone
for (const t of document.querySelectorAll('td time')) {
  const d = new Date(t.getAttribute('datetime'));
  if (!isNaN(d)) t.textContent = d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
// country names in English when PHP has no intl extension
try {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (const el of document.querySelectorAll('[data-country]')) el.textContent = names.of(el.dataset.country) || el.dataset.country;
} catch { /* the codes stay */ }
</script>
</body></html>
