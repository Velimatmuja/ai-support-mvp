<?php
// Veprimet e administratorit nga CLI:
//   php tests/wp/admin.php post <action> '<json të $_POST>'   -> {redirect, notice}
//   php tests/wp/admin.php render <tab>                        -> HTML i faqes së cilësimeve
require __DIR__ . '/stubs.php';
do_action('admin_init');
do_action('admin_menu');
[$_, $cmd, $arg] = $argv + [null, null, null];
if ($cmd === 'post') {
    $_POST = json_decode($argv[3] ?? '{}', true) ?: [];
    $_POST['_wpnonce'] = $_POST['_wpnonce'] ?? 'nonce-' . $arg;
    $out = ['redirect' => null, 'error' => null];
    try {
        do_action('admin_post_' . $arg);
    } catch (SbRedirect $r) {
        $out['redirect'] = $r->getMessage();
    } catch (Exception $e) {
        $out['error'] = $e->getMessage();
    }
    $out['notice'] = get_transient('supportbot_notice_1');
    delete_transient('supportbot_notice_1');
    echo json_encode($out);
} elseif ($cmd === 'render') {
    $_GET['tab'] = $arg;
    $GLOBALS['sb_pages']['supportbot']();
}
