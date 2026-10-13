<?php
// WordPress minimal për testet e plugin-it: vetëm funksionet që përdor plugin-i.
// Opsionet ruhen në një skedar JSON (SB_WP_STATE) që faqja publike (php -S) dhe
// veprimet admin (CLI) të ndajnë të njëjtën gjendje, si databaza e WordPress.
define('ABSPATH', __DIR__ . '/');

$GLOBALS['sb_actions'] = [];
$GLOBALS['sb_pages'] = [];

function sb_state_file() { return getenv('SB_WP_STATE') ?: sys_get_temp_dir() . '/sb-wp-state.json'; }
function sb_state() {
    $f = sb_state_file();
    return is_file($f) ? (json_decode((string) file_get_contents($f), true) ?: []) : [];
}
function sb_save_state($s) { file_put_contents(sb_state_file(), json_encode($s)); }

function add_action($hook, $cb, $prio = 10) { $GLOBALS['sb_actions'][$hook][$prio][] = $cb; }
function do_action($hook, ...$args) {
    $byPrio = $GLOBALS['sb_actions'][$hook] ?? [];
    ksort($byPrio);
    foreach ($byPrio as $cbs) foreach ($cbs as $cb) $cb(...$args);
}
function register_setting($group, $name, $args = []) {}
function add_options_page($t, $m, $cap, $slug, $cb) { $GLOBALS['sb_pages'][$slug] = $cb; }

function get_option($k, $d = false) { $s = sb_state(); return array_key_exists($k, $s['options'] ?? []) ? $s['options'][$k] : $d; }
function update_option($k, $v, $autoload = null) { $s = sb_state(); $s['options'][$k] = $v; sb_save_state($s); return true; }
function delete_option($k) { $s = sb_state(); unset($s['options'][$k]); sb_save_state($s); return true; }
function get_transient($k) { $s = sb_state(); return $s['transients'][$k] ?? false; }
function set_transient($k, $v, $ttl = 0) { $s = sb_state(); $s['transients'][$k] = $v; sb_save_state($s); return true; }
function delete_transient($k) { $s = sb_state(); unset($s['transients'][$k]); sb_save_state($s); return true; }

function current_user_can($cap) { return getenv('SB_WP_ROLE') !== 'subscriber'; }
function get_current_user_id() { return 1; }
function check_admin_referer($action) {
    if (($_POST['_wpnonce'] ?? '') !== 'nonce-' . $action) throw new Exception('nonce_failed:' . $action);
    return true;
}
function wp_nonce_field($action) { echo '<input type="hidden" name="_wpnonce" value="nonce-' . esc_attr($action) . '">'; }
class SbRedirect extends Exception {}
function wp_safe_redirect($url) { throw new SbRedirect($url); }
function wp_die($msg, $code = 500) { throw new Exception('wp_die:' . $code); }

function home_url($path = '') { return rtrim(getenv('SB_WP_HOME') ?: 'http://wp.test', '/') . $path; }
function admin_url($path = '') { return home_url('/wp-admin/' . $path); }
function esc_html($s) { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
function esc_attr($s) { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
function esc_textarea($s) { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
function esc_url($u, $protocols = null) { $u = (string) $u; return preg_match('#^(https?://|/)#i', $u) ? htmlspecialchars($u, ENT_QUOTES, 'UTF-8') : ''; }
function esc_url_raw($u, $protocols = ['http', 'https']) {
    $u = trim((string) $u);
    $scheme = strtolower((string) parse_url($u, PHP_URL_SCHEME));
    return in_array($scheme, $protocols, true) ? $u : '';
}
function __($s, $d = null) { return $s; }
function esc_html__($s, $d = null) { return esc_html($s); }
function esc_html_e($s, $d = null) { echo esc_html($s); }
function sanitize_email($s) { return filter_var(trim((string) $s), FILTER_SANITIZE_EMAIL); }
function sanitize_text_field($s) { return trim(preg_replace('/[\r\n\t ]+/', ' ', strip_tags((string) $s))); }
function sanitize_textarea_field($s) { return trim(strip_tags((string) $s)); }
function sanitize_key($s) { return preg_replace('/[^a-z0-9_\-]/', '', strtolower((string) $s)); }
function absint($n) { return abs((int) $n); }
function wp_unslash($v) { return $v; }
function wp_json_encode($v) { return json_encode($v); }
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function number_format_i18n($n) { return number_format((float) $n); }
function get_date_from_gmt($d) { return $d; }
function submit_button($text = 'Save', $type = 'primary', $name = 'submit', $wrap = true) { echo '<button type="submit">' . esc_html($text) . '</button>'; }
function settings_fields($g) {}
function paginate_links($a) { return ''; }
function add_query_arg($k, $v) { return '?' . $k . '=' . $v; }
function nocache_headers() {}

class WP_Error { public $code; public $message; function __construct($c = '', $m = '') { $this->code = $c; $this->message = $m; } }
function is_wp_error($x) { return $x instanceof WP_Error; }

// wp_remote_request me stream-et e PHP (pa curl), me timeout dhe pa ndjekur ridrejtime.
function wp_remote_request($url, $args) {
    $headers = [];
    foreach ($args['headers'] ?? [] as $k => $v) $headers[] = "$k: $v";
    $ctx = stream_context_create(['http' => [
        'method' => $args['method'] ?? 'GET',
        'header' => implode("\r\n", $headers),
        'content' => $args['body'] ?? '',
        'timeout' => $args['timeout'] ?? 5,
        'ignore_errors' => true,
        'follow_location' => 0,
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) return new WP_Error('http_request_failed', 'request failed');
    $status = 0;
    foreach ($http_response_header ?? [] as $h) if (preg_match('#^HTTP/\S+ (\d+)#', $h, $m)) $status = (int) $m[1];
    $s = sb_state();
    $s['requests'][] = ['method' => $args['method'] ?? 'GET', 'url' => $url, 'auth' => $args['headers']['authorization'] ?? null];
    sb_save_state($s);
    return ['body' => $body, 'response' => ['code' => $status]];
}
function wp_remote_retrieve_body($r) { return $r['body']; }
function wp_remote_retrieve_response_code($r) { return $r['response']['code']; }

require __DIR__ . '/../../wp-plugin/supportbot-widget/supportbot-widget.php';
