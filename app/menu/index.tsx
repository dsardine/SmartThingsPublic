import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import * as Sharing from 'expo-sharing';
import { type Href, useFocusEffect, useRouter } from 'expo-router';

import { PremiumPaywall } from '@/components/PremiumPaywall';
import {
  defaultExportEndDate,
  defaultExportStartDate,
  generateClinicalPDF,
  writeClinicalCsvFile,
} from '@/src/lib/exportService';
import {
  getHealthConnectMenuSummary,
  healthConnectHasAllReadPermissions,
  healthConnectOpenSettings,
  healthConnectRequestReadPermissions,
  healthConnectSyncMenstruationAndBbtToManualLogs,
} from '@/src/lib/healthConnectAndroid';
import {
  getHealthKitMenuSummary,
  healthKitHasAllReadPermissions,
  healthKitOpenHealthApp,
  healthKitRequestReadPermissions,
} from '@/src/lib/healthKitIOS';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import { colors } from '@/src/styles/theme';
import type { BbtTimeFormat, DateFormat, FirstDayOfWeek, TemperatureUnit } from '@/src/types/database';

export default function MenuScreen() {
  const router = useRouter();
  const session = useAppStore((s) => s.session);
  const prefs = useAppStore((s) => s.preferences);
  const setPreferences = useAppStore((s) => s.setPreferences);
  const isGhost = useAppStore((s) => s.isGhostModeEnabled);
  const setGhost = useAppStore((s) => s.setGhostModeEnabled);
  const [busy, setBusy] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [wearableSummary, setWearableSummary] = useState<string | null>(null);
  const [wearableBusy, setWearableBusy] = useState(false);
  /** When true, all Sardine read permissions are granted — hide "Allow access". */
  const [wearablePermissionsComplete, setWearablePermissionsComplete] = useState<boolean | null>(null);
  const [hcImportModalOpen, setHcImportModalOpen] = useState(false);
  /** `null` = import all history Health Connect allows (passes `null` as lookback). */
  const [hcLookbackChoice, setHcLookbackChoice] = useState<60 | 180 | null>(60);
  const [hcImportBusy, setHcImportBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        if (Platform.OS === 'android') {
          const [summary, granted] = await Promise.all([
            getHealthConnectMenuSummary(),
            healthConnectHasAllReadPermissions(),
          ]);
          if (alive) {
            setWearableSummary(summary);
            setWearablePermissionsComplete(granted);
          }
        } else if (Platform.OS === 'ios') {
          const [summary, granted] = await Promise.all([
            getHealthKitMenuSummary(),
            healthKitHasAllReadPermissions(),
          ]);
          if (alive) {
            setWearableSummary(summary);
            setWearablePermissionsComplete(granted);
          }
        } else if (alive) {
          setWearableSummary(null);
          setWearablePermissionsComplete(null);
        }
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  const persistProfile = useCallback(
    async (patch: {
      temperature_unit?: TemperatureUnit;
      first_day_of_week?: FirstDayOfWeek;
      date_format?: DateFormat;
      bbt_time_format?: BbtTimeFormat;
    }) => {
      if (!session?.user?.id) return;
      setBusy(true);
      try {
        const { error } = await supabase.from('profiles').update(patch).eq('id', session.user.id);
        if (error) {
          Alert.alert('Could not save', error.message);
          return;
        }
      } finally {
        setBusy(false);
      }
    },
    [session?.user?.id],
  );

  const setTempUnit = (u: TemperatureUnit) => {
    setPreferences({ temperatureUnit: u });
    void persistProfile({ temperature_unit: u });
  };

  const setFirstDow = (d: FirstDayOfWeek) => {
    setPreferences({ firstDayOfWeek: d });
    void persistProfile({ first_day_of_week: d });
  };

  const setFmt = (f: DateFormat) => {
    setPreferences({ dateFormat: f });
    void persistProfile({ date_format: f });
  };

  const setBbtTimeFmt = (tf: BbtTimeFormat) => {
    setPreferences({ bbtTimeFormat: tf });
    void persistProfile({ bbt_time_format: tf });
  };

  const sharePdf = async () => {
    if (!session?.user?.id) {
      Alert.alert('Sign in required', 'Exports attach to your Sardine account.');
      return;
    }
    setExportBusy(true);
    try {
      const uri = await generateClinicalPDF(defaultExportStartDate(), defaultExportEndDate());
      const ok = await Sharing.isAvailableAsync();
      if (!ok) {
        Alert.alert('Sharing unavailable', `PDF saved at:\n${uri}`);
        return;
      }
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: 'Sardine Empire LLC Clinical Report',
      });
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setExportBusy(false);
    }
  };

  const shareCsv = async () => {
    if (!session?.user?.id) {
      Alert.alert('Sign in required', 'Exports attach to your Sardine account.');
      return;
    }
    setExportBusy(true);
    try {
      const path = await writeClinicalCsvFile();
      const ok = await Sharing.isAvailableAsync();
      if (!ok) {
        Alert.alert('Sharing unavailable', `CSV saved at:\n${path}`);
        return;
      }
      await Sharing.shareAsync(path, {
        mimeType: 'text/csv',
        dialogTitle: 'Sardine Empire LLC Clinical Report',
      });
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setExportBusy(false);
    }
  };

  const runHealthConnectImport = async () => {
    if (Platform.OS !== 'android') return;
    if (!session?.user?.id && !isGhost) {
      Alert.alert('Sign in required', 'Sign in to import Health Connect data into your cloud manual log.');
      return;
    }
    setHcImportBusy(true);
    try {
      const lookbackDays = hcLookbackChoice === null ? null : hcLookbackChoice;
      const result = await healthConnectSyncMenstruationAndBbtToManualLogs({
        lookbackDays,
        temperatureUnit: prefs.temperatureUnit,
        isGhostMode: isGhost,
        userId: session?.user?.id ?? null,
      });
      if (!result.ok) {
        Alert.alert('Health Connect import', result.reason);
        return;
      }
      setHcImportModalOpen(false);
      Alert.alert(
        'Import complete',
        result.daysTouched === 0
          ? 'No new BBT or period flow records were found in that range.'
          : `Updated ${result.daysTouched} calendar day(s). Your cycle estimate was refreshed from bleeding history.`,
      );
    } finally {
      setHcImportBusy(false);
    }
  };

  const onWearableAllow = async () => {
    setWearableBusy(true);
    try {
      if (Platform.OS === 'android') {
        const result = await healthConnectRequestReadPermissions();
        if (!result.ok) {
          Alert.alert('Health Connect', result.reason);
          return;
        }
        setWearableSummary(await getHealthConnectMenuSummary());
        setWearablePermissionsComplete(await healthConnectHasAllReadPermissions());
      } else if (Platform.OS === 'ios') {
        const result = await healthKitRequestReadPermissions();
        if (!result.ok) {
          Alert.alert('Apple Health', result.reason);
          return;
        }
        setWearableSummary(await getHealthKitMenuSummary());
        setWearablePermissionsComplete(await healthKitHasAllReadPermissions());
      }
    } finally {
      setWearableBusy(false);
    }
  };

  const signOut = async () => {
    setSignOutBusy(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        Alert.alert('Sign out failed', error.message);
        return;
      }
      router.replace('/login' as Href);
    } finally {
      setSignOutBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Preferences</Text>
      <Text style={styles.sub}>Locale, calendar, and Ghost Mode stay yours — we just sync what you allow.</Text>

      {Platform.OS === 'android' || Platform.OS === 'ios' ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {Platform.OS === 'android' ? 'Google Health Connect' : 'Apple Health'}
          </Text>
          <Text style={styles.cardBody}>
            {wearableSummary ??
              (Platform.OS === 'android'
                ? 'Checking Health Connect… Sardine reads resting heart rate, HRV, respiratory rate, basal body temperature, and period flow when you allow it.'
                : 'Checking Apple Health… Sardine reads basal temperature, HRV (SDNN), resting heart rate, and respiratory rate when you allow it.')}
          </Text>
          {wearableBusy ? (
            <ActivityIndicator style={{ marginVertical: 10 }} color={colors.primarySageGreen} />
          ) : (
            <View style={styles.exportRow}>
              {wearablePermissionsComplete === false ? (
                <Pressable
                  style={styles.exportBtn}
                  onPress={() => void onWearableAllow()}
                  accessibilityRole="button"
                  accessibilityLabel={
                    Platform.OS === 'android' ? 'Allow Health Connect read access' : 'Allow Apple Health read access'
                  }>
                  <Text style={styles.exportBtnTxt}>Allow access</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={styles.secondaryOutlineBtn}
                onPress={() => {
                  if (Platform.OS === 'android') {
                    void healthConnectOpenSettings();
                  } else {
                    void healthKitOpenHealthApp();
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel={
                  Platform.OS === 'android' ? 'Open Health Connect settings' : 'Open Apple Health app'
                }>
                <Text style={styles.secondaryOutlineBtnTxt}>
                  {Platform.OS === 'android' ? 'Health Connect settings' : 'Open Health app'}
                </Text>
              </Pressable>
              {Platform.OS === 'android' && wearablePermissionsComplete ? (
                <Pressable
                  style={styles.secondaryOutlineBtn}
                  onPress={() => {
                    setHcLookbackChoice(60);
                    setHcImportModalOpen(true);
                  }}
                  disabled={hcImportBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Import period flow and BBT from Health Connect">
                  <Text style={styles.secondaryOutlineBtnTxt}>Import from Health Connect</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Ghost Mode</Text>
        <Text style={styles.cardBody}>
          When on, manual day logs never leave this device (MMKV). Perfect for borrowed phones or classified
          cycles.
        </Text>
        <View style={styles.row}>
          <Text style={styles.rowLbl}>Ghost Mode enabled</Text>
          <Switch
            value={isGhost}
            onValueChange={setGhost}
            trackColor={{ true: colors.primarySageGreen, false: colors.chartGrid }}
          />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Temperature unit</Text>
        <Text style={styles.cardBody}>Graph Y-axis labels and BBT entry follow this unit.</Text>
        <View style={styles.segment}>
          {(['F', 'C'] as const).map((u) => (
            <Pressable
              key={u}
              onPress={() => setTempUnit(u)}
              style={[styles.segBtn, prefs.temperatureUnit === u && styles.segBtnOn]}
              disabled={busy}>
              <Text style={[styles.segTxt, prefs.temperatureUnit === u && styles.segTxtOn]}>°{u}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Calendar start day</Text>
        <View style={styles.segment}>
          {(['Sunday', 'Monday'] as const).map((d) => (
            <Pressable
              key={d}
              onPress={() => setFirstDow(d)}
              style={[styles.segBtn, prefs.firstDayOfWeek === d && styles.segBtnOn]}
              disabled={busy}>
              <Text style={[styles.segTxt, prefs.firstDayOfWeek === d && styles.segTxtOn]}>{d}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Date format</Text>
        <View style={styles.segment}>
          {(['MM/DD/YYYY', 'DD/MM/YYYY'] as const).map((f) => (
            <Pressable
              key={f}
              onPress={() => setFmt(f)}
              style={[styles.segBtn, prefs.dateFormat === f && styles.segBtnOn]}
              disabled={busy}>
              <Text style={[styles.segTxt, prefs.dateFormat === f && styles.segTxtOn]}>{f}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>BBT time taken</Text>
        <Text style={styles.cardBody}>
          How the calendar shows the time you logged for manual BBT. Values are always stored as 24-hour
          (HH:MM).
        </Text>
        <View style={styles.segment}>
          {(['12h', '24h'] as const).map((tf) => (
            <Pressable
              key={tf}
              onPress={() => setBbtTimeFmt(tf)}
              style={[styles.segBtn, prefs.bbtTimeFormat === tf && styles.segBtnOn]}
              disabled={busy}>
              <Text style={[styles.segTxt, prefs.bbtTimeFormat === tf && styles.segTxtOn]}>
                {tf === '12h' ? '12-hour' : '24-hour'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Clinical export</Text>
        <Text style={styles.cardBody}>
          PDF and CSV use your date format preference and merge cloud data with Ghost Mode (MMKV) so the
          record is complete. Default window: last 90 days.
        </Text>
        {exportBusy ? (
          <ActivityIndicator style={{ marginVertical: 12 }} color={colors.primarySageGreen} />
        ) : (
          <View style={styles.exportRow}>
            <Pressable style={styles.exportBtn} onPress={() => void sharePdf()} disabled={!session}>
              <Text style={styles.exportBtnTxt}>Share PDF report</Text>
            </Pressable>
            <Pressable style={styles.exportBtn} onPress={() => void shareCsv()} disabled={!session}>
              <Text style={styles.exportBtnTxt}>Share CSV</Text>
            </Pressable>
          </View>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Sardine Premium</Text>
        <Text style={styles.cardBody}>RevenueCat entitlement: premium_access</Text>
        <Pressable style={styles.exportBtn} onPress={() => setPaywallOpen(true)}>
          <Text style={styles.exportBtnTxt}>Manage subscription</Text>
        </Pressable>
      </View>

      {session ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Account</Text>
          <Text style={styles.cardBody}>Signed in as {session.user.email ?? session.user.id}</Text>
          <Pressable
            style={[styles.signOutBtn, signOutBusy && styles.signOutBtnDisabled]}
            onPress={() => void signOut()}
            disabled={signOutBusy}
            accessibilityRole="button"
            accessibilityLabel="Sign out">
            {signOutBusy ? (
              <ActivityIndicator color={colors.mutedCoral} />
            ) : (
              <Text style={styles.signOutTxt}>Sign out</Text>
            )}
          </Pressable>
        </View>
      ) : null}

      <Modal visible={paywallOpen} animationType="slide" transparent onRequestClose={() => setPaywallOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPaywallOpen(false)} />
          <View style={styles.modalCard}>
            <PremiumPaywall onClose={() => setPaywallOpen(false)} />
          </View>
        </View>
      </Modal>

      <Modal
        visible={hcImportModalOpen}
        animationType="fade"
        transparent
        onRequestClose={() => !hcImportBusy && setHcImportModalOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !hcImportBusy && setHcImportModalOpen(false)} />
          <View style={styles.hcImportCard}>
            <Text style={styles.hcImportTitle}>How much past data should we import?</Text>
            <Text style={styles.hcImportBody}>
              More history usually improves predictions right away. Sardine only fills empty BBT and bleeding fields
              on each day so your manual entries always win. You stay in full control of what is imported.
            </Text>
            <View style={styles.hcRadioList}>
              {(
                [
                  { value: 60 as const, label: 'Last 60 days' },
                  { value: 180 as const, label: 'Last 6 months' },
                  { value: null, label: 'All available history' },
                ] as const
              ).map((opt) => (
                <Pressable
                  key={String(opt.value)}
                  style={[styles.hcRadioRow, hcLookbackChoice === opt.value && styles.hcRadioRowOn]}
                  onPress={() => setHcLookbackChoice(opt.value)}
                  disabled={hcImportBusy}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: hcLookbackChoice === opt.value }}>
                  <View style={[styles.hcRadioDot, hcLookbackChoice === opt.value && styles.hcRadioDotOn]} />
                  <Text style={styles.hcRadioLabel}>{opt.label}</Text>
                </Pressable>
              ))}
            </View>
            {hcImportBusy ? (
              <ActivityIndicator style={{ marginVertical: 14 }} color={colors.primarySageGreen} />
            ) : (
              <View style={styles.hcImportActions}>
                <Pressable
                  style={styles.secondaryOutlineBtn}
                  onPress={() => setHcImportModalOpen(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel Health Connect import">
                  <Text style={styles.secondaryOutlineBtnTxt}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={styles.exportBtn}
                  onPress={() => void runHealthConnectImport()}
                  accessibilityRole="button"
                  accessibilityLabel="Start Health Connect import">
                  <Text style={styles.exportBtnTxt}>Import</Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    padding: 20,
    paddingBottom: 40,
    backgroundColor: colors.background,
  },
  title: { fontSize: 26, fontWeight: '900', color: colors.textDark },
  sub: { marginTop: 8, fontSize: 15, color: colors.textMuted, lineHeight: 22, marginBottom: 16 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: colors.chartGrid,
  },
  cardTitle: { fontSize: 16, fontWeight: '800', color: colors.textDark, marginBottom: 6 },
  cardBody: { fontSize: 14, color: colors.textMuted, lineHeight: 20, marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowLbl: { fontSize: 15, fontWeight: '600', color: colors.textDark },
  segment: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  segBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.chartGrid,
    backgroundColor: colors.background,
  },
  segBtnOn: { backgroundColor: colors.primarySageGreen, borderColor: colors.primarySageGreen },
  segTxt: { fontWeight: '700', color: colors.textDark, fontSize: 14 },
  segTxtOn: { color: colors.card },
  exportRow: { gap: 10 },
  exportBtn: {
    marginTop: 4,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: colors.primarySageGreen,
    alignItems: 'center',
  },
  exportBtnTxt: { color: colors.card, fontWeight: '800', fontSize: 15 },
  modalRoot: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  modalCard: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  signOutBtn: {
    marginTop: 4,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.mutedCoral,
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  signOutBtnDisabled: { opacity: 0.6 },
  signOutTxt: { color: colors.mutedCoral, fontWeight: '800', fontSize: 15 },
  secondaryOutlineBtn: {
    marginTop: 4,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.primarySageGreen,
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  secondaryOutlineBtnTxt: { color: colors.primarySageGreen, fontWeight: '800', fontSize: 15 },
  hcImportCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.chartGrid,
  },
  hcImportTitle: { fontSize: 18, fontWeight: '800', color: colors.textDark, marginBottom: 8 },
  hcImportBody: { fontSize: 14, color: colors.textMuted, lineHeight: 21, marginBottom: 14 },
  hcRadioList: { gap: 10, marginBottom: 8 },
  hcRadioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.chartGrid,
    backgroundColor: colors.background,
  },
  hcRadioRowOn: { borderColor: colors.primarySageGreen, backgroundColor: colors.card },
  hcRadioDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.chartGrid,
  },
  hcRadioDotOn: { borderColor: colors.primarySageGreen, backgroundColor: colors.primarySageGreen },
  hcRadioLabel: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.textDark },
  hcImportActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
});
