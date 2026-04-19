const { withMainActivity } = require('@expo/config-plugins');

/**
 * Registers Health Connect permission ActivityResult contracts on MainActivity.
 * Required for react-native-health-connect requestPermission() to show the system UI.
 */
function withHealthConnectMainActivity(config) {
  return withMainActivity(config, async (cfg) => {
    let contents = cfg.modResults.contents;
    if (contents.includes('HealthConnectPermissionDelegate')) {
      return cfg;
    }
    if (!contents.includes('import expo.modules.ReactActivityDelegateWrapper')) {
      throw new Error(
        'withHealthConnectMainActivity: MainActivity.kt missing ReactActivityDelegateWrapper import; update the plugin for your Expo template.',
      );
    }
    contents = contents.replace(
      'import expo.modules.ReactActivityDelegateWrapper',
      `import expo.modules.ReactActivityDelegateWrapper
import dev.matinzd.healthconnect.permissions.HealthConnectPermissionDelegate`,
    );
    if (!contents.includes('super.onCreate(null)')) {
      throw new Error('withHealthConnectMainActivity: expected super.onCreate(null) in MainActivity.kt');
    }
    contents = contents.replace(
      'super.onCreate(null)',
      `super.onCreate(null)
    HealthConnectPermissionDelegate.setPermissionDelegate(this)`,
    );
    cfg.modResults.contents = contents;
    return cfg;
  });
}

module.exports = withHealthConnectMainActivity;
