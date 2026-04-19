import { Platform } from 'react-native';

import type { Permission } from 'react-native-health-connect';

/** Read types aligned with `app.json` android.health permissions and fertility biometrics use. */
export const SARDINE_HEALTH_CONNECT_READ: Permission[] = [
  { accessType: 'read', recordType: 'BasalBodyTemperature' },
  { accessType: 'read', recordType: 'HeartRateVariabilityRmssd' },
  { accessType: 'read', recordType: 'RestingHeartRate' },
  { accessType: 'read', recordType: 'RespiratoryRate' },
];

export const HEALTH_CONNECT_SOFT_NUDGE_DISMISSED_KEY = 'health_connect_soft_nudge_dismissed';

function permissionSatisfied(granted: Permission[], want: Permission): boolean {
  return granted.some((g) => g.accessType === want.accessType && g.recordType === want.recordType);
}

async function loadHealthConnectModule(): Promise<typeof import('react-native-health-connect') | null> {
  if (Platform.OS !== 'android') return null;
  try {
    return await import('react-native-health-connect');
  } catch {
    return null;
  }
}

export async function healthConnectEnsureInitialized(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (Platform.OS !== 'android') {
    return { ok: false, reason: 'Health Connect is only available on Android.' };
  }
  const hc = await loadHealthConnectModule();
  if (!hc) {
    return {
      ok: false,
      reason: 'Health Connect native module is not available. Rebuild the Android app (development or production build — not Expo Go).',
    };
  }
  try {
    const status = await hc.getSdkStatus();
    if (status !== hc.SdkAvailabilityStatus.SDK_AVAILABLE) {
      return {
        ok: false,
        reason:
          'Health Connect is not ready on this device. On Android 13 and below, install Health Connect from the Play Store; on Android 14+ ensure the system Health Connect service is available.',
      };
    }
    const initialized = await hc.initialize();
    if (!initialized) {
      return { ok: false, reason: 'Could not initialize Health Connect.' };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : 'Health Connect initialization failed.',
    };
  }
}

export async function healthConnectHasAllReadPermissions(): Promise<boolean> {
  const init = await healthConnectEnsureInitialized();
  if (!init.ok) return false;
  const hc = await loadHealthConnectModule();
  if (!hc) return false;
  try {
    const raw = await hc.getGrantedPermissions();
    const granted = raw.filter(
      (item): item is Permission =>
        item != null && typeof item === 'object' && 'recordType' in item && 'accessType' in item,
    );
    return SARDINE_HEALTH_CONNECT_READ.every((p) => permissionSatisfied(granted, p));
  } catch {
    return false;
  }
}

export async function healthConnectRequestReadPermissions(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const init = await healthConnectEnsureInitialized();
  if (!init.ok) return { ok: false, reason: init.reason };
  const hc = await loadHealthConnectModule();
  if (!hc) return { ok: false, reason: 'Health Connect module failed to load.' };
  try {
    await hc.requestPermission(SARDINE_HEALTH_CONNECT_READ);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : 'Permission request failed.',
    };
  }
}

export async function healthConnectOpenSettings(): Promise<void> {
  const hc = await loadHealthConnectModule();
  if (!hc) return;
  try {
    hc.openHealthConnectSettings();
  } catch {
    // no-op
  }
}

/** Short status line for the menu card. */
export async function getHealthConnectMenuSummary(): Promise<string> {
  if (Platform.OS !== 'android') return '';
  const init = await healthConnectEnsureInitialized();
  if (!init.ok) return init.reason;
  const all = await healthConnectHasAllReadPermissions();
  return all
    ? 'Sardine can read your permitted vitals from Health Connect.'
    : 'Not connected — tap below to allow read access for BBT, HRV, resting heart rate, and respiratory rate.';
}
