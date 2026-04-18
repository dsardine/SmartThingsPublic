import { Platform } from 'react-native';
import Purchases from 'react-native-purchases';

/**
 * Configure RevenueCat once at startup. Keys are optional until you add them to `.env`.
 */
export function initRevenueCat(): void {
  const iosKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY ?? '';
  const androidKey = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY ?? '';
  const apiKey = Platform.OS === 'ios' ? iosKey : androidKey;

  if (!apiKey) {
    if (__DEV__) {
      console.warn(
        '[RevenueCat] Missing EXPO_PUBLIC_REVENUECAT_IOS_API_KEY or EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY',
      );
    }
    return;
  }

  Purchases.configure({ apiKey });
}
