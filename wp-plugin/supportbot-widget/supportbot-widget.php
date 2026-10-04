<?php
/**
 * Plugin Name: SupportBot Chat Widget
 * Description: Shton widget-in e chat-it SupportBot në faqe. Vendos Widget Key te Settings → SupportBot.
 * Version: 0.1.0
 * License: GPL-2.0-or-later
 */

if (!defined('ABSPATH')) {
    exit;
}

// Ndryshoje me domenin tënd të Vercel përpara se ta shpërndash plugin-in.
if (!defined('SUPPORTBOT_APP_URL')) {
    define('SUPPORTBOT_APP_URL', 'https://PROJEKTI.vercel.app');
}

add_action('admin_init', function () {
    register_setting('supportbot', 'supportbot_widget_key', [
        'type' => 'string',
        'default' => '',
        // Pranohet vetëm formati i çelësit publik: asgjë tjetër nuk arrin në HTML.
        'sanitize_callback' => function ($value) {
            $value = trim((string) $value);
            return preg_match('/^wk_[a-f0-9]{32}$/', $value) ? $value : '';
        },
    ]);
});

add_action('admin_menu', function () {
    add_options_page('SupportBot', 'SupportBot', 'manage_options', 'supportbot', function () {
        ?>
        <div class="wrap">
            <h1>SupportBot</h1>
            <form method="post" action="options.php">
                <?php settings_fields('supportbot'); ?>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="supportbot_widget_key">Widget Key</label></th>
                        <td>
                            <input type="text" class="regular-text code" id="supportbot_widget_key"
                                   name="supportbot_widget_key" placeholder="wk_..."
                                   value="<?php echo esc_attr(get_option('supportbot_widget_key', '')); ?>">
                            <p class="description">E gjen në panelin SupportBot. Është çelës publik, jo sekret.</p>
                        </td>
                    </tr>
                </table>
                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    });
});

add_action('wp_footer', function () {
    $key = get_option('supportbot_widget_key', '');
    if (!preg_match('/^wk_[a-f0-9]{32}$/', $key)) {
        return;
    }
    printf(
        '<script src="%s" data-key="%s" async></script>' . "\n",
        esc_url(rtrim(SUPPORTBOT_APP_URL, '/') . '/widget.js'),
        esc_attr($key)
    );
});
