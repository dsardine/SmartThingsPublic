import { Linking, Platform } from 'react-native';
import {
  AuthorizationStatus,
  authorizationStatusFor,
  isHealthDataAvailableAsync,
  requestAuthorization,
} from '@kingstinct/react-native-healthkit';
import type { QuantityTypeIdentifier } from '@kingstinct/react-native-healthkit';

/** Quantity types Sardine uses for cycle / nocturnal biometrics (aligned with Android Health Connect). */
export const SARDINE_HEALTHKIT_READ: readonly QuantityTypeIdentifier[] = [
  'HKQuantityTypeIdentifierBasalBodyTemperature',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  'HKQuantityTypeIdentifierRestingHeartRate',
  'HKQuantityTypeIdentifierRespiratoryRate',
];

export const HEALTH_KIT_SOFT_NUDGE_DISMISSED_KEY = 'health_kit_soft_nudge_dismissed';

export async function healthKitEnsureAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (Platform.OS !== 'ios') {
    return { ok: false, reason: 'Apple Health (HealthKit) is only available on iOS.' };
  }
  try {
    const available = await isHealthDataAvailableAsync();
    if (!available) {
      return { ok: false, reason: 'Health data is not available on this device.' };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : 'HealthKit is unavailable.',
    };
  }
}

export async function healthKitHasAllReadPermissions(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  const init = await healthKitEnsureAvailable();
  if (!init.ok) return false;
  try {
    return SARDINE_HEALTHKIT_READ.every(
      (id) => authorizationStatusFor(id) === AuthorizationStatus.sharingAuthorized,
    );
  } catch {
    return false;
  }
}

export async function healthKitRequestReadPermissions(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const init = await healthKitEnsureAvailable();
  if (!init.ok) return { ok: false, reason: init.reason };
  try {
    const ok = await requestAuthorization({ toRead: [...SARDINE_HEALTHKIT_READ] });
    if (!ok) {
      return {
        ok: false,
        reason: 'Authorization was not completed. You can try again or enable access in the Health app.',
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : 'Health authorization failed.',
    };
  }
}

export async function healthKitOpenHealthApp(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const url = 'x-apple-health://';
  const can = await Linking.canOpenURL(url);
  if (can) void Linking.openURL(url);
}

export async function getHealthKitMenuSummary(): Promise<string> {
  if (Platform.OS !== 'ios') return '';
  const init = await healthKitEnsureAvailable();
  if (!init.ok) return init.reason;
  const all = await healthKitHasAllReadPermissions();
  return all
    ? 'Sardine can read your permitted metrics from Apple Health (basal temperature, HRV, resting heart rate, respiratory rate).'
    : 'Not connected — tap below to allow Sardine to read the health types it needs from Apple Health.';
}
