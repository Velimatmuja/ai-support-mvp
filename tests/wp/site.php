<?php
// Faqja publike e "WordPress-it" të testit: php -S 127.0.0.1:PORT tests/wp/site.php
require __DIR__ . '/stubs.php';
do_action('init');
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if ($path === '/robots.txt') {
    header('Content-Type: text/plain');
    echo "User-agent: *\nDisallow: /wp-admin/\n";
    return;
}
if ($path !== '/' && $path !== '/shipping/') {
    http_response_code(404);
    echo 'not found';
    return;
}
header('Content-Type: text/html; charset=utf-8');
?><!doctype html><html lang="en"><head><title><?php echo $path === '/' ? 'WP Demo Shop' : 'Shipping'; ?></title><?php do_action('wp_head'); ?></head>
<body><nav><a href="/">Home</a> <a href="/shipping/">Shipping</a> <a href="/wp-admin/">Admin</a></nav>
<main><?php if ($path === '/') : ?>
<h1>WP Demo Shop</h1><p>WP Demo Shop sells handmade ceramic mugs and teapots made in Berat.</p>
<?php else : ?>
<h1>Shipping</h1><p>Ceramic orders are shipped in recycled cardboard within three working days across Albania and Kosovo.</p>
<?php endif; ?></main><?php do_action('wp_footer'); ?></body></html>
