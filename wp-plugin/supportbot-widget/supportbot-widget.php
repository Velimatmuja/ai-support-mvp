<?php
/**
 * Plugin Name: ANESP SupportBot
 * Description: AI chat widget that learns from your own website. Connect your SupportBot account, and the assistant builds its knowledge base from your public pages automatically. Manual FAQ entries stay optional.
 * Version: 0.2.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 * Text Domain: supportbot
 */

if (!defined('ABSPATH')) {
    exit;
}

/*
 * Siguria (pse është ndërtuar kështu):
 *  - Të gjitha thirrjet te API bëhen nga PHP (server-me-server). Çelësi API ruhet në
 *    wp_options (autoload = no) dhe nuk shfaqet kurrë në HTML ose JavaScript.
 *  - Fjalëkalimi i llogarisë përdoret vetëm një herë për të marrë çelësin; nuk ruhet.
 *  - Çdo veprim admin kërkon `manage_options` + nonce; çdo output kalon nga esc_*.
 *  - Skanimi i site-it NUK bëhet brenda kërkesave të WordPress: plugin-i vetëm e nis
 *    dhe lexon statusin; crawl-i ekzekutohet nga worker-i i SupportBot në sfond.
 *  - Widget-i në faqe merr vetëm widget_key publik.
 */

const SUPPORTBOT_VERSION = '0.2.0';
const SUPPORTBOT_KEY_RE = '/^wk_[a-f0-9]{32}$/';
const SUPPORTBOT_TOKEN_RE = '/^anesp-[a-f0-9]{32}$/';

// Adresa e aplikacionit: konstante në wp-config.php (fiton) ose fushë te cilësimet.
function supportbot_app_url() {
    if (defined('SUPPORTBOT_APP_URL') && SUPPORTBOT_APP_URL) {
        return rtrim(SUPPORTBOT_APP_URL, '/');
    }
    return rtrim((string) get_option('supportbot_app_url', ''), '/');
}

function supportbot_api_key() {
    return (string) get_option('supportbot_api_key', '');
}

function supportbot_connected() {
    return supportbot_app_url() !== '' && preg_match('/^ak_[a-f0-9]{64}$/', supportbot_api_key());
}

/**
 * Thirrje te API e SupportBot. Kthen ['status' => int, 'data' => array] ose WP_Error.
 */
function supportbot_api($method, $path, $body = null, $auth = true) {
    $base = supportbot_app_url();
    if ($base === '') {
        return new WP_Error('supportbot_no_url', __('Set the SupportBot app address first.', 'supportbot'));
    }
    $args = [
        'method' => $method,
        'timeout' => 25,
        'redirection' => 0,
        'headers' => ['accept' => 'application/json'],
    ];
    if ($auth) {
        $args['headers']['authorization'] = 'Bearer ' . supportbot_api_key();
    }
    if ($body !== null) {
        $args['headers']['content-type'] = 'application/json';
        $args['body'] = wp_json_encode($body);
    }
    $res = wp_remote_request($base . $path, $args);
    if (is_wp_error($res)) {
        return $res;
    }
    $data = json_decode(wp_remote_retrieve_body($res), true);
    return ['status' => (int) wp_remote_retrieve_response_code($res), 'data' => is_array($data) ? $data : []];
}

// Kodet e gabimeve të API -> mesazhe për administratorin (pa detaje të brendshme).
function supportbot_error_message($code) {
    $map = [
        'invalid_credentials' => __('Email or password is not correct.', 'supportbot'),
        'invalid_credentials_format' => __('Enter a valid email and password.', 'supportbot'),
        'owner_only' => __('Only the account owner can connect a website.', 'supportbot'),
        'unauthorized' => __('The connection is no longer valid. Connect the plugin again.', 'supportbot'),
        'rate_limited' => __('Too many attempts. Wait a few minutes and try again.', 'supportbot'),
        'invalid_url' => __('This is not a valid website address.', 'supportbot'),
        'url_not_allowed' => __('This address cannot be scanned (private or local addresses are not allowed).', 'supportbot'),
        'url_not_resolvable' => __('This domain could not be found. Check the address.', 'supportbot'),
        'source_exists' => __('This website is already registered.', 'supportbot'),
        'source_limit_reached' => __('Your plan does not allow more websites.', 'supportbot'),
        'verification_failed' => __('Ownership check failed. If you use a page cache, clear it and try again.', 'supportbot'),
        'site_unreachable' => __('Your website could not be reached for the ownership check.', 'supportbot'),
        'source_not_verified' => __('Verify website ownership first.', 'supportbot'),
        'source_disabled' => __('This knowledge source is disabled.', 'supportbot'),
        'plan_inactive' => __('Your plan is not active.', 'supportbot'),
        'job_active' => __('A scan is already running.', 'supportbot'),
        'nothing_to_retry' => __('There is nothing to retry.', 'supportbot'),
        'invalid_exclude_patterns' => __('One of the excluded paths is not valid.', 'supportbot'),
        'duplicate_document' => __('This exact text is already in your knowledge.', 'supportbot'),
        'content_too_short' => __('Add a title and at least a sentence of text.', 'supportbot'),
        'content_too_long' => __('This text is too long. Split it into smaller entries.', 'supportbot'),
        'kb_limit_reached' => __('Your knowledge base has reached the limit of your plan.', 'supportbot'),
    ];
    return isset($map[$code]) ? $map[$code] : __('Something went wrong. Please try again.', 'supportbot');
}

// Njoftime pas redirect-it (Post/Redirect/Get), për përdoruesin aktual.
function supportbot_notice($type, $message) {
    set_transient('supportbot_notice_' . get_current_user_id(), ['type' => $type, 'message' => $message], 60);
}

function supportbot_result_notice($res, $success) {
    if (is_wp_error($res)) {
        supportbot_notice('error', __('Could not reach SupportBot. Check the app address and try again.', 'supportbot'));
        return false;
    }
    if ($res['status'] >= 200 && $res['status'] < 300) {
        if ($success) {
            supportbot_notice('success', $success);
        }
        return true;
    }
    $code = isset($res['data']['error']) ? (string) $res['data']['error'] : '';
    if ($code === 'unauthorized') {
        // Çelësi u revokua nga paneli: shkëput plugin-in që të lidhet sërish.
        delete_option('supportbot_api_key');
    }
    supportbot_notice('error', supportbot_error_message($code));
    return false;
}

function supportbot_redirect($tab) {
    wp_safe_redirect(admin_url('options-general.php?page=supportbot&tab=' . rawurlencode($tab)));
    exit;
}

function supportbot_require_admin($action) {
    if (!current_user_can('manage_options')) {
        wp_die(esc_html__('You are not allowed to do this.', 'supportbot'), 403);
    }
    check_admin_referer($action);
}

// -----------------------------------------------------------------------------
// Cilësimet bazë (widget key manual mbetet i mbështetur për instalimet e vjetra)
// -----------------------------------------------------------------------------
add_action('admin_init', function () {
    register_setting('supportbot', 'supportbot_widget_key', [
        'type' => 'string',
        'default' => '',
        // Pranohet vetëm formati i çelësit publik: asgjë tjetër nuk arrin në HTML.
        'sanitize_callback' => function ($value) {
            $value = trim((string) $value);
            return preg_match(SUPPORTBOT_KEY_RE, $value) ? $value : '';
        },
    ]);
    register_setting('supportbot', 'supportbot_app_url', [
        'type' => 'string',
        'default' => '',
        'sanitize_callback' => function ($value) {
            $value = esc_url_raw(trim((string) $value), ['https']);
            return preg_match('#^https://[^/\s]+#', $value) ? rtrim($value, '/') : '';
        },
    ]);
});

// -----------------------------------------------------------------------------
// Veprimet admin (admin-post.php)
// -----------------------------------------------------------------------------
add_action('admin_post_supportbot_connect', function () {
    supportbot_require_admin('supportbot_connect');
    $email = sanitize_email(wp_unslash($_POST['email'] ?? ''));
    // Fjalëkalimi nuk sanitizohet (mund të ketë çdo karakter) dhe nuk ruhet.
    $password = (string) wp_unslash($_POST['password'] ?? '');
    $res = supportbot_api('POST', '/api/plugin/connect', ['email' => $email, 'password' => $password, 'siteUrl' => home_url('/')], false);
    if (supportbot_result_notice($res, __('Connected. You can now build the knowledge base from your website.', 'supportbot'))) {
        update_option('supportbot_api_key', (string) $res['data']['apiKey'], false);
        if (preg_match(SUPPORTBOT_KEY_RE, (string) ($res['data']['widgetKey'] ?? ''))) {
            update_option('supportbot_widget_key', $res['data']['widgetKey']);
        }
        update_option('supportbot_account_name', sanitize_text_field((string) ($res['data']['tenantName'] ?? '')), false);
    }
    supportbot_redirect('knowledge');
});

add_action('admin_post_supportbot_disconnect', function () {
    supportbot_require_admin('supportbot_disconnect');
    if (supportbot_connected()) {
        supportbot_api('DELETE', '/api/plugin/connect');
    }
    foreach (['supportbot_api_key', 'supportbot_source_id', 'supportbot_verification_token', 'supportbot_account_name'] as $opt) {
        delete_option($opt);
    }
    supportbot_notice('success', __('Disconnected. The API key was revoked.', 'supportbot'));
    supportbot_redirect('connection');
});

function supportbot_exclusions_from_post() {
    $lines = preg_split('/\r\n|\r|\n/', (string) wp_unslash($_POST['exclude_patterns'] ?? ''));
    $out = [];
    foreach ($lines as $line) {
        $line = trim(sanitize_text_field($line));
        if ($line !== '') {
            $out[] = $line;
        }
    }
    return array_slice(array_values(array_unique($out)), 0, 100);
}

add_action('admin_post_supportbot_register_site', function () {
    supportbot_require_admin('supportbot_register_site');
    $url = esc_url_raw(wp_unslash($_POST['site_url'] ?? home_url('/')), ['http', 'https']);
    $res = supportbot_api('POST', '/api/kb/sources', [
        'url' => $url,
        'max_pages' => max(1, min(5000, absint($_POST['max_pages'] ?? 100))),
        'max_depth' => max(0, min(10, absint($_POST['max_depth'] ?? 3))),
        'exclude_patterns' => supportbot_exclusions_from_post(),
    ]);
    if (supportbot_result_notice($res, null)) {
        $source = $res['data']['source'];
        update_option('supportbot_source_id', sanitize_text_field($source['id']), false);
        $token = (string) ($res['data']['verification']['token'] ?? '');
        if (preg_match(SUPPORTBOT_TOKEN_RE, $token)) {
            // Ruhet para verifikimit: meta tag-u dhe skedari /.well-known/ e shfaqin menjëherë.
            update_option('supportbot_verification_token', $token);
            $verify = supportbot_api('POST', '/api/kb/sources/' . rawurlencode($source['id']) . '/verify');
            supportbot_result_notice($verify, __('Website verified. The first scan has started in the background.', 'supportbot'));
        } else {
            supportbot_notice('success', __('Website registered. The first scan has started in the background.', 'supportbot'));
        }
    }
    supportbot_redirect('knowledge');
});

// Veprime të thjeshta mbi burimin: verify / sync / retry / enable / disable / delete / settings.
add_action('admin_post_supportbot_source_action', function () {
    supportbot_require_admin('supportbot_source_action');
    $id = (string) get_option('supportbot_source_id', '');
    if (!preg_match('/^[0-9a-f-]{36}$/', $id)) {
        supportbot_redirect('knowledge');
    }
    $path = '/api/kb/sources/' . rawurlencode($id);
    $do = sanitize_key($_POST['do'] ?? '');
    switch ($do) {
        case 'verify':
            supportbot_result_notice(supportbot_api('POST', $path . '/verify'), __('Website verified. The first scan has started in the background.', 'supportbot'));
            break;
        case 'sync':
            supportbot_result_notice(supportbot_api('POST', $path . '/sync'), __('Rescan started in the background.', 'supportbot'));
            break;
        case 'retry':
            supportbot_result_notice(supportbot_api('POST', $path . '/retry'), __('Failed pages were queued again.', 'supportbot'));
            break;
        case 'enable':
        case 'disable':
            supportbot_result_notice(
                supportbot_api('PATCH', $path, ['enabled' => $do === 'enable']),
                $do === 'enable' ? __('Website knowledge enabled.', 'supportbot') : __('Website knowledge disabled. The assistant no longer uses it.', 'supportbot')
            );
            break;
        case 'settings':
            $res = supportbot_api('PATCH', $path, [
                'exclude_patterns' => supportbot_exclusions_from_post(),
                'max_pages' => max(1, min(5000, absint($_POST['max_pages'] ?? 100))),
                'max_depth' => max(0, min(10, absint($_POST['max_depth'] ?? 3))),
                'sync_interval_hours' => max(1, min(8760, absint($_POST['sync_interval_hours'] ?? 168))),
            ]);
            $removed = is_array($res) ? (int) ($res['data']['removed_documents'] ?? 0) : 0;
            /* translators: %d: number of pages removed by the new exclusions */
            supportbot_result_notice($res, sprintf(__('Settings saved. %d excluded pages were removed from the knowledge base.', 'supportbot'), $removed));
            break;
        case 'delete':
            if (supportbot_result_notice(supportbot_api('DELETE', $path), __('Website and all its indexed pages were deleted.', 'supportbot'))) {
                delete_option('supportbot_source_id');
                delete_option('supportbot_verification_token');
            }
            break;
    }
    supportbot_redirect('knowledge');
});

add_action('admin_post_supportbot_document', function () {
    supportbot_require_admin('supportbot_document');
    $id = sanitize_text_field(wp_unslash($_POST['document_id'] ?? ''));
    $tab = sanitize_key($_POST['tab'] ?? 'knowledge');
    if (preg_match('/^[0-9a-f-]{36}$/', $id)) {
        $do = sanitize_key($_POST['do'] ?? '');
        if ($do === 'delete') {
            supportbot_result_notice(supportbot_api('DELETE', '/api/kb/documents/' . rawurlencode($id)), __('Deleted.', 'supportbot'));
        } else {
            supportbot_result_notice(supportbot_api('PATCH', '/api/kb/documents/' . rawurlencode($id), ['enabled' => $do === 'enable']), __('Saved.', 'supportbot'));
        }
    }
    supportbot_redirect($tab === 'faq' ? 'faq' : 'knowledge');
});

add_action('admin_post_supportbot_faq_add', function () {
    supportbot_require_admin('supportbot_faq_add');
    $title = sanitize_text_field(wp_unslash($_POST['title'] ?? ''));
    $content = sanitize_textarea_field(wp_unslash($_POST['content'] ?? ''));
    supportbot_result_notice(supportbot_api('POST', '/api/kb/ingest', ['title' => $title, 'content' => $content]), __('FAQ entry added to the knowledge base.', 'supportbot'));
    supportbot_redirect('faq');
});

// -----------------------------------------------------------------------------
// Faqja e cilësimeve
// -----------------------------------------------------------------------------
function supportbot_status_label($status) {
    $labels = [
        'pending' => __('Pending', 'supportbot'),
        'crawling' => __('Crawling', 'supportbot'),
        'indexing' => __('Indexing', 'supportbot'),
        'ready' => __('Ready', 'supportbot'),
        'failed' => __('Failed', 'supportbot'),
    ];
    return isset($labels[$status]) ? $labels[$status] : $status;
}

function supportbot_action_button($do, $label, $class = 'button', $confirm = '') {
    $onsubmit = $confirm ? ' onsubmit="return confirm(' . esc_attr(wp_json_encode($confirm)) . ');"' : '';
    echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="display:inline-block;margin:0 6px 6px 0"' . $onsubmit . '>';
    wp_nonce_field('supportbot_source_action');
    echo '<input type="hidden" name="action" value="supportbot_source_action"><input type="hidden" name="do" value="' . esc_attr($do) . '">';
    echo '<button type="submit" class="' . esc_attr($class) . '">' . esc_html($label) . '</button></form>';
}

function supportbot_document_toggle($doc, $tab) {
    $enabled = !empty($doc['enabled']);
    echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="display:inline">';
    wp_nonce_field('supportbot_document');
    echo '<input type="hidden" name="action" value="supportbot_document"><input type="hidden" name="tab" value="' . esc_attr($tab) . '">';
    echo '<input type="hidden" name="document_id" value="' . esc_attr($doc['id']) . '"><input type="hidden" name="do" value="' . ($enabled ? 'disable' : 'enable') . '">';
    echo '<button type="submit" class="button-link">' . ($enabled ? esc_html__('Disable', 'supportbot') : esc_html__('Enable', 'supportbot')) . '</button></form>';
}

function supportbot_render_connection() {
    $connected = supportbot_connected();
    ?>
    <h2><?php esc_html_e('Account', 'supportbot'); ?></h2>
    <?php if (!defined('SUPPORTBOT_APP_URL')) : ?>
        <form method="post" action="options.php">
            <?php settings_fields('supportbot'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="supportbot_app_url"><?php esc_html_e('SupportBot app address', 'supportbot'); ?></label></th>
                    <td><input type="url" class="regular-text code" id="supportbot_app_url" name="supportbot_app_url" placeholder="https://app.example.com" value="<?php echo esc_attr(get_option('supportbot_app_url', '')); ?>">
                        <p class="description"><?php esc_html_e('HTTPS only. You find it in your SupportBot welcome email.', 'supportbot'); ?></p></td>
                </tr>
                <tr>
                    <th scope="row"><label for="supportbot_widget_key"><?php esc_html_e('Widget key', 'supportbot'); ?></label></th>
                    <td><input type="text" class="regular-text code" id="supportbot_widget_key" name="supportbot_widget_key" placeholder="wk_..." value="<?php echo esc_attr(get_option('supportbot_widget_key', '')); ?>">
                        <p class="description"><?php esc_html_e('Filled in automatically when you connect. It is a public key, not a secret.', 'supportbot'); ?></p></td>
                </tr>
            </table>
            <?php submit_button(__('Save', 'supportbot')); ?>
        </form>
    <?php endif; ?>

    <?php if ($connected) : ?>
        <p><span class="dashicons dashicons-yes-alt" style="color:#00a32a"></span>
            <?php
            /* translators: %s: account name */
            echo esc_html(sprintf(__('Connected to %s.', 'supportbot'), (string) get_option('supportbot_account_name', 'SupportBot')));
            ?></p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" onsubmit="return confirm(<?php echo esc_attr(wp_json_encode(__('Disconnect this website? The API key will be revoked.', 'supportbot'))); ?>);">
            <?php wp_nonce_field('supportbot_disconnect'); ?>
            <input type="hidden" name="action" value="supportbot_disconnect">
            <?php submit_button(__('Disconnect', 'supportbot'), 'secondary', 'submit', false); ?>
        </form>
    <?php elseif (supportbot_app_url() !== '') : ?>
        <p><?php esc_html_e('Sign in with your SupportBot account. Your password is used once to create a revocable key for this website and is not stored.', 'supportbot'); ?></p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <?php wp_nonce_field('supportbot_connect'); ?>
            <input type="hidden" name="action" value="supportbot_connect">
            <table class="form-table" role="presentation">
                <tr><th scope="row"><label for="sb-email"><?php esc_html_e('Email', 'supportbot'); ?></label></th>
                    <td><input type="email" id="sb-email" name="email" class="regular-text" required autocomplete="username"></td></tr>
                <tr><th scope="row"><label for="sb-password"><?php esc_html_e('Password', 'supportbot'); ?></label></th>
                    <td><input type="password" id="sb-password" name="password" class="regular-text" required autocomplete="current-password"></td></tr>
            </table>
            <?php submit_button(__('Connect', 'supportbot')); ?>
        </form>
    <?php endif;
}

function supportbot_render_knowledge() {
    if (!supportbot_connected()) {
        echo '<p>' . esc_html__('Connect your account first (Connection tab).', 'supportbot') . '</p>';
        return;
    }
    $source_id = (string) get_option('supportbot_source_id', '');
    $source = null;
    if ($source_id !== '') {
        $list = supportbot_api('GET', '/api/kb/sources');
        if (!is_wp_error($list) && $list['status'] === 200) {
            foreach ($list['data']['sources'] as $s) {
                if ($s['id'] === $source_id) {
                    $source = $s;
                }
            }
            if (!$source) {
                delete_option('supportbot_source_id'); // u fshi nga paneli
            }
        } elseif (!is_wp_error($list) && $list['status'] === 401) {
            // Çelësi u revokua nga paneli.
            delete_option('supportbot_api_key');
            echo '<p>' . esc_html__('The connection is no longer valid. Connect the plugin again (Connection tab).', 'supportbot') . '</p>';
            return;
        } else {
            echo '<div class="notice notice-error"><p>' . esc_html__('Could not load the status. Try again in a moment.', 'supportbot') . '</p></div>';
            return;
        }
    }

    if (!$source) {
        ?>
        <h2><?php esc_html_e('Build the knowledge base from your website', 'supportbot'); ?></h2>
        <p><?php esc_html_e('SupportBot reads the public pages of your website in the background, keeps them up to date, and the assistant answers from them. No FAQ writing needed.', 'supportbot'); ?></p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <?php wp_nonce_field('supportbot_register_site'); ?>
            <input type="hidden" name="action" value="supportbot_register_site">
            <table class="form-table" role="presentation">
                <tr><th scope="row"><label for="sb-url"><?php esc_html_e('Website address', 'supportbot'); ?></label></th>
                    <td><input type="url" id="sb-url" name="site_url" class="regular-text code" value="<?php echo esc_attr(home_url('/')); ?>" required></td></tr>
                <tr><th scope="row"><label for="sb-pages"><?php esc_html_e('Maximum pages', 'supportbot'); ?></label></th>
                    <td><input type="number" id="sb-pages" name="max_pages" min="1" max="5000" value="100"></td></tr>
                <tr><th scope="row"><label for="sb-depth"><?php esc_html_e('Link depth', 'supportbot'); ?></label></th>
                    <td><input type="number" id="sb-depth" name="max_depth" min="0" max="10" value="3"></td></tr>
                <tr><th scope="row"><label for="sb-ex"><?php esc_html_e('Exclude paths', 'supportbot'); ?></label></th>
                    <td><textarea id="sb-ex" name="exclude_patterns" rows="3" class="large-text code" placeholder="/blog/tag/&#10;/shop/*?orderby=*"></textarea>
                        <p class="description"><?php esc_html_e('One per line. Admin, login, cart, checkout and feeds are always excluded.', 'supportbot'); ?></p></td></tr>
            </table>
            <?php submit_button(__('Register and start scanning', 'supportbot')); ?>
        </form>
        <?php
        return;
    }

    $job = isset($source['last_job']) && is_array($source['last_job']) ? $source['last_job'] : [];
    $status = (string) $source['status'];
    $active = in_array($status, ['pending', 'crawling', 'indexing'], true);
    if ($active) {
        // Rifreskim i thjeshtë i faqes ndërsa skanimi është aktiv.
        echo '<script>setTimeout(function(){location.reload();},10000);</script>';
    }
    $n = function ($key) use ($job) {
        return number_format_i18n(isset($job[$key]) ? (int) $job[$key] : 0);
    };
    ?>
    <h2><?php echo esc_html($source['root_url']); ?></h2>
    <p><strong><?php esc_html_e('Status:', 'supportbot'); ?></strong>
        <span class="supportbot-status supportbot-<?php echo esc_attr($status); ?>"><?php echo esc_html(supportbot_status_label($status)); ?></span>
        <?php if (empty($source['enabled'])) : ?> — <em><?php esc_html_e('disabled', 'supportbot'); ?></em><?php endif; ?>
        <?php if ($active) : ?> <span class="spinner is-active" style="float:none;margin:0 4px"></span><?php endif; ?>
    </p>

    <?php if (empty($source['verified_at']) && !empty($source['verification'])) : ?>
        <div class="notice notice-warning inline"><p>
            <?php esc_html_e('Ownership is not verified yet. This plugin already adds the verification tag to your pages; if you use a page cache, clear it and press Verify.', 'supportbot'); ?>
        </p></div>
        <?php supportbot_action_button('verify', __('Verify', 'supportbot'), 'button button-primary'); ?>
    <?php endif; ?>

    <table class="widefat striped" style="max-width:720px;margin:12px 0">
        <tbody>
        <tr><td><?php esc_html_e('Pages in the knowledge base', 'supportbot'); ?></td><td><strong><?php echo esc_html(number_format_i18n((int) $source['documents'])); ?></strong></td></tr>
        <tr><td><?php esc_html_e('Discovered in the last scan', 'supportbot'); ?></td><td><?php echo esc_html($n('pages_discovered')); ?></td></tr>
        <tr><td><?php esc_html_e('Processed', 'supportbot'); ?></td><td><?php echo esc_html($n('pages_processed')); ?>
            (<?php
            /* translators: 1: new/changed pages, 2: unchanged pages */
            echo esc_html(sprintf(__('%1$s new or changed, %2$s unchanged', 'supportbot'), $n('pages_indexed'), $n('pages_unchanged')));
            ?>)</td></tr>
        <tr><td><?php esc_html_e('Failed', 'supportbot'); ?></td><td><?php echo esc_html($n('pages_failed')); ?></td></tr>
        <tr><td><?php esc_html_e('Skipped (not found, private, noindex, not HTML)', 'supportbot'); ?></td><td><?php echo esc_html($n('pages_skipped')); ?></td></tr>
        <tr><td><?php esc_html_e('Last successful scan', 'supportbot'); ?></td><td><?php echo esc_html($source['last_synced_at'] ? get_date_from_gmt(gmdate('Y-m-d H:i:s', strtotime($source['last_synced_at']))) : '—'); ?></td></tr>
        <tr><td><?php esc_html_e('Next automatic scan', 'supportbot'); ?></td><td><?php echo esc_html($source['next_sync_at'] ? get_date_from_gmt(gmdate('Y-m-d H:i:s', strtotime($source['next_sync_at']))) : '—'); ?></td></tr>
        <?php if (!empty($job['truncated'])) : ?>
            <tr><td colspan="2"><em><?php esc_html_e('The scan reached the page limit of your plan; some pages were not read.', 'supportbot'); ?></em></td></tr>
        <?php endif; ?>
        <?php if (!empty($job['incomplete'])) : ?>
            <tr><td colspan="2"><em><?php esc_html_e('The sitemap could not be read during the last scan, so no pages were removed.', 'supportbot'); ?></em></td></tr>
        <?php endif; ?>
        </tbody>
    </table>

    <p>
        <?php
        if (!$active && !empty($source['verified_at'])) {
            supportbot_action_button('sync', __('Rescan now', 'supportbot'), 'button button-primary');
        }
        if (!$active && ($status === 'failed' || (isset($job['pages_failed']) && (int) $job['pages_failed'] > 0))) {
            supportbot_action_button('retry', __('Retry failed pages', 'supportbot'));
        }
        if (!empty($source['enabled'])) {
            supportbot_action_button('disable', __('Disable website knowledge', 'supportbot'));
        } else {
            supportbot_action_button('enable', __('Enable website knowledge', 'supportbot'));
        }
        supportbot_action_button('delete', __('Delete website and its pages', 'supportbot'), 'button button-link-delete', __('Delete this website and every indexed page? This cannot be undone.', 'supportbot'));
        ?>
    </p>

    <h3><?php esc_html_e('Scan settings', 'supportbot'); ?></h3>
    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
        <?php wp_nonce_field('supportbot_source_action'); ?>
        <input type="hidden" name="action" value="supportbot_source_action"><input type="hidden" name="do" value="settings">
        <table class="form-table" role="presentation">
            <tr><th scope="row"><label for="sb-ex2"><?php esc_html_e('Exclude paths', 'supportbot'); ?></label></th>
                <td><textarea id="sb-ex2" name="exclude_patterns" rows="4" class="large-text code"><?php echo esc_textarea(implode("\n", (array) $source['exclude_patterns'])); ?></textarea>
                    <p class="description"><?php esc_html_e('One path per line, e.g. /blog/ or */tag/*. Matching pages are removed immediately.', 'supportbot'); ?></p></td></tr>
            <tr><th scope="row"><label for="sb-pages2"><?php esc_html_e('Maximum pages', 'supportbot'); ?></label></th>
                <td><input type="number" id="sb-pages2" name="max_pages" min="1" max="5000" value="<?php echo esc_attr((int) $source['max_pages']); ?>"></td></tr>
            <tr><th scope="row"><label for="sb-depth2"><?php esc_html_e('Link depth', 'supportbot'); ?></label></th>
                <td><input type="number" id="sb-depth2" name="max_depth" min="0" max="10" value="<?php echo esc_attr((int) $source['max_depth']); ?>"></td></tr>
            <tr><th scope="row"><label for="sb-int"><?php esc_html_e('Rescan every (hours)', 'supportbot'); ?></label></th>
                <td><input type="number" id="sb-int" name="sync_interval_hours" min="1" max="8760" value="<?php echo esc_attr((int) $source['sync_interval_hours']); ?>"></td></tr>
        </table>
        <?php submit_button(__('Save scan settings', 'supportbot'), 'secondary'); ?>
    </form>

    <?php
    $detail = supportbot_api('GET', '/api/kb/sources/' . rawurlencode($source['id']));
    if (!is_wp_error($detail) && $detail['status'] === 200) {
        $problems = array_filter((array) $detail['data']['events'], function ($e) {
            return in_array($e['level'], ['warn', 'error'], true);
        });
        $failed = (array) $detail['data']['failed_urls'];
        if ($problems || $failed) {
            echo '<h3>' . esc_html__('Problems in the last scan', 'supportbot') . '</h3><table class="widefat striped" style="max-width:960px"><thead><tr><th>'
                . esc_html__('Page', 'supportbot') . '</th><th>' . esc_html__('Reason', 'supportbot') . '</th></tr></thead><tbody>';
            foreach (array_slice($failed, 0, 50) as $f) {
                echo '<tr><td><code>' . esc_html($f['url']) . '</code></td><td>' . esc_html($f['reason'] . ($f['http_status'] ? ' (HTTP ' . (int) $f['http_status'] . ')' : '')) . '</td></tr>';
            }
            foreach (array_slice($problems, 0, 50) as $e) {
                echo '<tr><td><code>' . esc_html((string) $e['url']) . '</code></td><td>' . esc_html($e['code'] . ($e['message'] ? ': ' . $e['message'] : '')) . '</td></tr>';
            }
            echo '</tbody></table>';
        }
    }

    $paged = max(1, absint($_GET['paged'] ?? 1));
    $docs = supportbot_api('GET', '/api/kb/documents?limit=50&offset=' . (($paged - 1) * 50) . '&source_id=' . rawurlencode($source['id']));
    if (!is_wp_error($docs) && $docs['status'] === 200) {
        echo '<h3>' . esc_html__('Indexed pages', 'supportbot') . '</h3>';
        echo '<p class="description">' . esc_html__('A disabled page stays out of the answers, also after rescans. To keep a page out permanently, add its path to the exclusions.', 'supportbot') . '</p>';
        echo '<table class="widefat striped" style="max-width:960px"><thead><tr><th>' . esc_html__('Page', 'supportbot') . '</th><th>' . esc_html__('Language', 'supportbot') . '</th><th>' . esc_html__('Parts', 'supportbot') . '</th><th>' . esc_html__('Used', 'supportbot') . '</th></tr></thead><tbody>';
        foreach ((array) $docs['data']['documents'] as $d) {
            echo '<tr><td><a href="' . esc_url($d['url']) . '" target="_blank" rel="noopener noreferrer">' . esc_html($d['title']) . '</a><br><code style="font-size:11px">' . esc_html($d['url']) . '</code></td>';
            echo '<td>' . esc_html((string) $d['language']) . '</td><td>' . esc_html((string) (int) $d['chunk_count']) . '</td><td>';
            echo $d['enabled'] ? esc_html__('Yes', 'supportbot') . ' · ' : esc_html__('No', 'supportbot') . ' · ';
            supportbot_document_toggle($d, 'knowledge');
            echo '</td></tr>';
        }
        echo '</tbody></table>';
        $total = (int) $docs['data']['total'];
        if ($total > 50) {
            echo '<p>' . paginate_links(['base' => add_query_arg('paged', '%#%'), 'format' => '', 'current' => $paged, 'total' => (int) ceil($total / 50)]) . '</p>';
        }
    }
}

function supportbot_render_faq() {
    if (!supportbot_connected()) {
        echo '<p>' . esc_html__('Connect your account first (Connection tab).', 'supportbot') . '</p>';
        return;
    }
    ?>
    <h2><?php esc_html_e('Manual FAQ (optional)', 'supportbot'); ?></h2>
    <p><?php esc_html_e('Add answers that are not on your website, or override unclear pages. The assistant uses them together with your website.', 'supportbot'); ?></p>
    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
        <?php wp_nonce_field('supportbot_faq_add'); ?>
        <input type="hidden" name="action" value="supportbot_faq_add">
        <p><label for="sb-faq-title"><?php esc_html_e('Title', 'supportbot'); ?></label><br>
            <input type="text" id="sb-faq-title" name="title" class="regular-text" maxlength="200" required></p>
        <p><label for="sb-faq-content"><?php esc_html_e('Questions and answers', 'supportbot'); ?></label><br>
            <textarea id="sb-faq-content" name="content" rows="8" class="large-text" maxlength="200000" required></textarea></p>
        <?php submit_button(__('Add to knowledge', 'supportbot')); ?>
    </form>
    <?php
    $docs = supportbot_api('GET', '/api/kb/documents?limit=100&source_id=manual');
    if (is_wp_error($docs) || $docs['status'] !== 200) {
        return;
    }
    echo '<table class="widefat striped" style="max-width:960px"><thead><tr><th>' . esc_html__('Title', 'supportbot') . '</th><th>' . esc_html__('Parts', 'supportbot') . '</th><th>' . esc_html__('Used', 'supportbot') . '</th><th></th></tr></thead><tbody>';
    foreach ((array) $docs['data']['documents'] as $d) {
        echo '<tr><td>' . esc_html($d['title']) . '</td><td>' . esc_html((string) (int) $d['chunk_count']) . '</td><td>';
        echo $d['enabled'] ? esc_html__('Yes', 'supportbot') . ' · ' : esc_html__('No', 'supportbot') . ' · ';
        supportbot_document_toggle($d, 'faq');
        echo '</td><td><form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" onsubmit="return confirm(' . esc_attr(wp_json_encode(__('Delete this entry?', 'supportbot'))) . ');">';
        wp_nonce_field('supportbot_document');
        echo '<input type="hidden" name="action" value="supportbot_document"><input type="hidden" name="tab" value="faq"><input type="hidden" name="do" value="delete">';
        echo '<input type="hidden" name="document_id" value="' . esc_attr($d['id']) . '"><button type="submit" class="button-link button-link-delete">' . esc_html__('Delete', 'supportbot') . '</button></form></td></tr>';
    }
    echo '</tbody></table>';
}

add_action('admin_menu', function () {
    add_options_page('SupportBot', 'SupportBot', 'manage_options', 'supportbot', function () {
        if (!current_user_can('manage_options')) {
            return;
        }
        $tabs = [
            'connection' => __('Connection', 'supportbot'),
            'knowledge' => __('Website knowledge', 'supportbot'),
            'faq' => __('Manual FAQ', 'supportbot'),
        ];
        $tab = sanitize_key($_GET['tab'] ?? '');
        if (!isset($tabs[$tab])) {
            $tab = supportbot_connected() ? 'knowledge' : 'connection';
        }
        $notice = get_transient('supportbot_notice_' . get_current_user_id());
        delete_transient('supportbot_notice_' . get_current_user_id());
        ?>
        <div class="wrap">
            <h1>SupportBot</h1>
            <?php if ($notice) : ?>
                <div class="notice notice-<?php echo $notice['type'] === 'error' ? 'error' : 'success'; ?> is-dismissible"><p><?php echo esc_html($notice['message']); ?></p></div>
            <?php endif; ?>
            <nav class="nav-tab-wrapper">
                <?php foreach ($tabs as $key => $label) : ?>
                    <a href="<?php echo esc_url(admin_url('options-general.php?page=supportbot&tab=' . $key)); ?>" class="nav-tab<?php echo $tab === $key ? ' nav-tab-active' : ''; ?>"><?php echo esc_html($label); ?></a>
                <?php endforeach; ?>
            </nav>
            <style>.supportbot-status{padding:2px 8px;border-radius:10px;background:#f0f0f1}.supportbot-ready{background:#d1fadf}.supportbot-failed{background:#fde2e1}.supportbot-crawling,.supportbot-indexing,.supportbot-pending{background:#fff4ce}</style>
            <?php
            if ($tab === 'connection') {
                supportbot_render_connection();
            } elseif ($tab === 'knowledge') {
                supportbot_render_knowledge();
            } else {
                supportbot_render_faq();
            }
            ?>
        </div>
        <?php
    });
});

// -----------------------------------------------------------------------------
// Faqja publike
// -----------------------------------------------------------------------------

// Verifikimi i pronësisë: meta tag në çdo faqe + skedar në /.well-known/ (punon edhe
// kur cache-i i faqeve shërben HTML të vjetër). Token-i nuk është sekret.
add_action('wp_head', function () {
    $token = (string) get_option('supportbot_verification_token', '');
    if (preg_match(SUPPORTBOT_TOKEN_RE, $token)) {
        echo '<meta name="anesp-site-verification" content="' . esc_attr($token) . '">' . "\n";
    }
}, 1);

add_action('init', function () {
    $path = wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
    if ($path !== '/.well-known/anesp-verification.txt') {
        return;
    }
    $token = (string) get_option('supportbot_verification_token', '');
    if (!preg_match(SUPPORTBOT_TOKEN_RE, $token)) {
        return;
    }
    nocache_headers();
    header('Content-Type: text/plain; charset=utf-8');
    echo $token; // formati është verifikuar me regex: vetëm [a-z0-9-]
    exit;
}, 0);

add_action('wp_footer', function () {
    $key = (string) get_option('supportbot_widget_key', '');
    $base = supportbot_app_url();
    if (!preg_match(SUPPORTBOT_KEY_RE, $key) || $base === '') {
        return;
    }
    printf(
        '<script src="%s" data-key="%s" async></script>' . "\n",
        esc_url($base . '/widget.js'),
        esc_attr($key)
    );
});
