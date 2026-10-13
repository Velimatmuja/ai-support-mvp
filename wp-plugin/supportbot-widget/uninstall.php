<?php
// Çinstalimi: hiq çdo opsion të plugin-it, përfshirë çelësin API.
// (Çelësi revokohet nga butoni "Disconnect"; nga paneli mund të revokohet edhe pas çinstalimit.)
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}
foreach (['supportbot_widget_key', 'supportbot_app_url', 'supportbot_api_key', 'supportbot_source_id', 'supportbot_verification_token', 'supportbot_account_name'] as $option) {
    delete_option($option);
}
