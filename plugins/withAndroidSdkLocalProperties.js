/**
 * Writes `android/local.properties` with `sdk.dir` after prebuild so Gradle can find the SDK.
 * Prebuild regenerates `android/` and does not preserve a hand-created `local.properties`.
 * Resolves from ANDROID_HOME / ANDROID_SDK_ROOT, then default install locations.
 */
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

function resolveAndroidSdkDir() {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return path.normalize(fromEnv);
  }
  if (process.platform === 'win32') {
    const d = path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
    if (fs.existsSync(d)) return d;
  }
  if (process.platform === 'darwin') {
    const d = path.join(process.env.HOME || '', 'Library', 'Android', 'sdk');
    if (fs.existsSync(d)) return d;
  }
  const d = path.join(process.env.HOME || '', 'Android', 'Sdk');
  if (fs.existsSync(d)) return d;
  return null;
}

function withAndroidSdkLocalProperties(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const androidRoot = path.join(projectRoot, 'android');
      const localProps = path.join(androidRoot, 'local.properties');
      const sdk = resolveAndroidSdkDir();
      if (!sdk) {
        console.warn(
          '[withAndroidSdkLocalProperties] Android SDK not found. Set ANDROID_HOME or add android/local.properties manually.',
        );
        return cfg;
      }
      const sdkDir = sdk.replace(/\\/g, '/');
      const content = `## Generated at prebuild — set ANDROID_HOME to override\nsdk.dir=${sdkDir}\n`;
      fs.mkdirSync(androidRoot, { recursive: true });
      fs.writeFileSync(localProps, content, 'utf8');
      return cfg;
    },
  ]);
}

module.exports = withAndroidSdkLocalProperties;
