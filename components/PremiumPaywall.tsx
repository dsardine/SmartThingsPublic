import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Purchases, { type CustomerInfo, type PurchasesPackage } from 'react-native-purchases';

import { useAppStore } from '@/src/store';
import { colors } from '@/src/styles/theme';

const PREMIUM_ENTITLEMENT = 'premium_access';

const TERMS_URL =
  process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL ?? 'https://example.com/terms-of-service';
const PRIVACY_URL =
  process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL ?? 'https://example.com/privacy-policy';

type Props = {
  onClose?: () => void;
};

export function PremiumPaywall({ onClose }: Props) {
  const session = useAppStore((s) => s.session);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [monthly, setMonthly] = useState<PurchasesPackage | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const info = await Purchases.getCustomerInfo();
      setCustomerInfo(info);
      const offerings = await Purchases.getOfferings();
      const current = offerings.current;
      const pkg =
        current?.monthly ?? current?.availablePackages?.[0] ?? null;
      setMonthly(pkg ?? null);
    } catch (e) {
      console.warn('[PremiumPaywall]', e);
      setCustomerInfo(null);
      setMonthly(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    void Purchases.logIn(uid).catch(() => {});
  }, [session?.user?.id]);

  const hasPremium = Boolean(customerInfo?.entitlements.active[PREMIUM_ENTITLEMENT]);

  const purchase = async () => {
    if (!monthly) {
      Alert.alert('Unavailable', 'No subscription package is configured in RevenueCat yet.');
      return;
    }
    setBusy(true);
    try {
      const { customerInfo: next } = await Purchases.purchasePackage(monthly);
      setCustomerInfo(next);
      if (next.entitlements.active[PREMIUM_ENTITLEMENT]) {
        Alert.alert('Welcome', 'Premium access is active on this device.');
        onClose?.();
      }
    } catch (e: unknown) {
      const cancelled =
        typeof e === 'object' && e !== null && 'userCancelled' in e && (e as { userCancelled?: boolean }).userCancelled;
      if (!cancelled) {
        Alert.alert('Purchase failed', e instanceof Error ? e.message : 'Unknown error');
      }
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      const info = await Purchases.restorePurchases();
      setCustomerInfo(info);
      if (info.entitlements.active[PREMIUM_ENTITLEMENT]) {
        Alert.alert('Restored', 'Premium access restored.');
        onClose?.();
      } else {
        Alert.alert('No subscription found', 'No active premium entitlement on this Apple ID / Play account.');
      }
    } catch (e) {
      Alert.alert('Restore failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Sardine Premium</Text>
      <Text style={styles.body}>
        Clinical exports, advanced scoring, and partner workflows unlock with the{' '}
        <Text style={styles.mono}>{PREMIUM_ENTITLEMENT}</Text> entitlement in RevenueCat.
      </Text>

      {loading ? (
        <ActivityIndicator style={{ marginVertical: 16 }} color={colors.primarySageGreen} />
      ) : (
        <>
          <Text style={styles.status}>
            Status: {hasPremium ? 'Premium active' : 'Free tier'}
          </Text>
          <Pressable
            style={[styles.primary, busy && styles.disabled]}
            onPress={() => void purchase()}
            disabled={busy || hasPremium}>
            <Text style={styles.primaryTxt}>
              {hasPremium ? 'Subscribed' : monthly ? `Subscribe (${monthly.product.title})` : 'Subscribe'}
            </Text>
          </Pressable>
        </>
      )}

      <Pressable style={[styles.secondary, busy && styles.disabled]} onPress={() => void restore()} disabled={busy}>
        <Text style={styles.secondaryTxt}>Restore Purchases</Text>
      </Pressable>

      <View style={styles.links}>
        <Pressable onPress={() => void Linking.openURL(TERMS_URL)}>
          <Text style={styles.link}>Terms of Service</Text>
        </Pressable>
        <Text style={styles.dot}> · </Text>
        <Pressable onPress={() => void Linking.openURL(PRIVACY_URL)}>
          <Text style={styles.link}>Privacy Policy</Text>
        </Pressable>
      </View>

      {onClose ? (
        <Pressable style={styles.ghost} onPress={onClose} disabled={busy}>
          <Text style={styles.ghostTxt}>Close</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.chartGrid,
  },
  title: { fontSize: 22, fontWeight: '900', color: colors.textDark },
  body: { marginTop: 10, fontSize: 15, color: colors.textMuted, lineHeight: 22 },
  mono: { fontFamily: 'monospace', fontSize: 13, color: colors.textDark },
  status: { marginTop: 14, fontWeight: '700', color: colors.textDark },
  primary: {
    marginTop: 14,
    backgroundColor: colors.primarySageGreen,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryTxt: { color: colors.card, fontWeight: '800', fontSize: 16 },
  secondary: {
    marginTop: 10,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.primarySageGreen,
    alignItems: 'center',
  },
  secondaryTxt: { color: colors.primarySageGreen, fontWeight: '800' },
  links: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: 18,
    alignItems: 'center',
  },
  link: { color: colors.softLavender, fontWeight: '700', textDecorationLine: 'underline' },
  dot: { color: colors.textMuted },
  ghost: { marginTop: 12, alignItems: 'center' },
  ghostTxt: { color: colors.textMuted, fontWeight: '600' },
  disabled: { opacity: 0.55 },
});
