/**
 * Ensures all Health Connect data-type `uses-permission` entries exist on the merged manifest.
 * Without READ_SLEEP / READ_MENSTRUATION / READ_BODY_TEMPERATURE / READ_HEALTH_DATA_HISTORY,
 * the OS will not offer those categories when Sardine requests Health Connect access.
 */
const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

const SARDINE_HEALTH_READ_PERMISSIONS = [
  'android.permission.health.READ_BASAL_BODY_TEMPERATURE',
  'android.permission.health.READ_BODY_TEMPERATURE',
  'android.permission.health.READ_HEALTH_DATA_HISTORY',
  'android.permission.health.READ_HEART_RATE_VARIABILITY',
  'android.permission.health.READ_MENSTRUATION',
  'android.permission.health.READ_RESTING_HEART_RATE',
  'android.permission.health.READ_RESPIRATORY_RATE',
  'android.permission.health.READ_SLEEP',
];

function withAndroidHealthConnectDataPermissions(config) {
  return withAndroidManifest(config, async (cfg) => {
    const manifest = cfg.modResults;
    for (const name of SARDINE_HEALTH_READ_PERMISSIONS) {
      AndroidConfig.Permissions.ensurePermission(manifest, name);
    }
    return cfg;
  });
}

module.exports = withAndroidHealthConnectDataPermissions;
