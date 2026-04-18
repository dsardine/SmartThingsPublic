import * as LocalAuthentication from 'expo-local-authentication';

import { appStorage } from '@/src/lib/storage';

const APP_LOCK_ENABLED_KEY = 'app_lock_enabled';

export function getAppLockEnabled(): boolean {
  return appStorage.getBoolean(APP_LOCK_ENABLED_KEY) ?? false;
}

/**
 * Runs the biometric gate when App Lock is enabled in `appStorage`.
 * No-op when disabled or when biometrics are unavailable.
 */
export async function runInitialAppLockGate(): Promise<void> {
  if (!getAppLockEnabled()) return;

  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  if (!hasHardware) return;

  const enrolled = await LocalAuthentication.isEnrolledAsync();
  if (!enrolled) return;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Sardine',
      cancelLabel: 'Cancel',
    });
    if (result.success) return;
  }
}
