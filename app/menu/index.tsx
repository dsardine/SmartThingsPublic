import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
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

import { formatCalendarDate, isoDateString, parseIsoDate } from '@/src/lib/dateDisplay';
import { LIFE_STAGE_CHOICES, WHY_HERE_OPTIONS } from '@/src/lib/userCyclePreferencesCopy';

import { PremiumPaywall } from '@/components/PremiumPaywall';
import {
  defaultExportEndDate,
  defaultExportStartDate,
  generateClinicalPDF,
  writeClinicalCsvFile,
} from '@/src/lib/exportService';
import {
  healthConnectGetPermissionUiState,
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
import {
  getTrackOnlyBbtDailyRemindersOptIn,
  setTrackOnlyBbtDailyRemindersOptIn,
} from '@/src/lib/trackOnlyNotificationPrefs';
import { useAppStore } from '@/src/store';
import { colors } from '@/src/styles/theme';
import type {
  BbtTimeFormat,
  ClinicalState,
  DateFormat,
  FirstDayOfWeek,
  TemperatureUnit,
  TrackingGoal,
} from '@/src/types/database';

export default function MenuScreen() {
  const router = useRouter();
  const session = useAppStore((s) => s.session);
  const prefs = useAppStore((s) => s.preferences);
  const setPreferences = useAppStore((s) => s.setPreferences);
  const hydrateClinicalFromProfile = useAppStore((s) => s.hydrateClinicalFromProfile);
  const hydrateCycleLengthFromProfile = useAppStore((s) => s.hydrateCycleLengthFromProfile);
  const clinicalState = useAppStore((s) => s.clinicalState);
  const trackingGoal = useAppStore((s) => s.trackingGoal);
  const setClinicalState = useAppStore((s) => s.setClinicalState);
  const setTrackingGoal = useAppStore((s) => s.setTrackingGoal);
  const setClinicalCycleAnchorIso = useAppStore((s) => s.setClinicalCycleAnchorIso);
  const isGhost = useAppStore((s) => s.isGhostModeEnabled);
  const setGhost = useAppStore((s) => s.setGhostModeEnabled);
  const lastPeriodDateIso = useAppStore((s) => s.lastPeriodDateIso);
  const cycleLengthAvg = useAppStore((s) => s.cycleLengthAvg);
  const [busy, setBusy] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [wearableSummary, setWearableSummary] = useState<string | null>(null);
  const [wearableBusy, setWearableBusy] = useState(false);
  /** When true, all Sardine Health Connect read types are granted — hide "Allow access". */
  const [wearablePermissionsComplete, setWearablePermissionsComplete] = useState<boolean | null>(null);
  /** When true, at least one HC read type is granted — show "Import from Health Connect". */
  const [wearableHcAnyRead, setWearableHcAnyRead] = useState<boolean | null>(null);
  const [hcImportModalOpen, setHcImportModalOpen] = useState(false);
  /** `null` = import all history Health Connect allows (passes `null` as lookback). */
  const [hcLookbackChoice, setHcLookbackChoice] = useState<60 | 180 | null>(60);
  const [hcImportBusy, setHcImportBusy] = useState(false);
  const [trackOnlyBbtOptIn, setTrackOnlyBbtOptIn] = useState(getTrackOnlyBbtDailyRemindersOptIn);

  useEffect(() => {
    setTrackOnlyBbtOptIn(getTrackOnlyBbtDailyRemindersOptIn());
  }, [trackingGoal]);

  /** Re-query OS permission state (Health Connect / HealthKit). */
  const refreshWearablePermissionState = useCallback(
    async (cancelled?: () => boolean) => {
      const dead = () => cancelled?.() === true;
      if (Platform.OS === 'android') {
        const ui = await healthConnectGetPermissionUiState();
        if (dead()) return;
        setWearableSummary(ui.summary);
        setWearablePermissionsComplete(ui.allGranted);
        setWearableHcAnyRead(ui.anyGranted);
        return;
      }
      if (Platform.OS === 'ios') {
        const [summary, granted] = await Promise.all([
          getHealthKitMenuSummary(),
          healthKitHasAllReadPermissions(),
        ]);
        if (dead()) return;
        setWearableSummary(summary);
        setWearablePermissionsComplete(granted);
        setWearableHcAnyRead(null);
        return;
      }
      if (dead()) return;
      setWearableSummary(null);
      setWearablePermissionsComplete(null);
      setWearableHcAnyRead(null);
    },
    [],
  );

  useEffect(() => {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return;
    const onAppState = (s: AppStateStatus) => {
      if (s === 'active') void refreshWearablePermissionState();
    };
    const sub = AppState.addEventListener('change', onAppState);
    return () => sub.remove();
  }, [refreshWearablePermissionState]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const cancelled = () => !alive;
      void (async () => {
        if (session?.user?.id) {
          const { data } = await supabase
            .from('profiles')
            .select(
              'clinical_state, tracking_goal, clinical_cycle_anchor_iso, last_period_date, cycle_length_avg',
            )
            .eq('id', session.user.id)
            .maybeSingle();
          if (alive && data) {
            hydrateClinicalFromProfile({
              clinical_state: data.clinical_state as ClinicalState | undefined,
              tracking_goal: data.tracking_goal as TrackingGoal | undefined,
              clinical_cycle_anchor_iso: (data as { clinical_cycle_anchor_iso?: string | null })
                .clinical_cycle_anchor_iso,
            });
            const row = data as { cycle_length_avg?: number | null; last_period_date?: string | null };
            const serverCl =
              typeof row.cycle_length_avg === 'number' && Number.isFinite(row.cycle_length_avg)
                ? Math.round(row.cycle_length_avg)
                : 28;
            hydrateCycleLengthFromProfile({
              serverCycleLengthAvg: serverCl,
              isGhostMode: isGhost,
              lastPeriodDateIso: typeof row.last_period_date === 'string' ? row.last_period_date : null,
            });
          }
        }
        await refreshWearablePermissionState(cancelled);
      })();
      return () => {
        alive = false;
      };
    }, [
      session?.user?.id,
      hydrateClinicalFromProfile,
      hydrateCycleLengthFromProfile,
      isGhost,
      refreshWearablePermissionState,
    ]),
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

  const applyClinicalState = async (next: ClinicalState) => {
    if (!session?.user?.id || isGhost) return;
    const prev = useAppStore.getState().clinicalState;
    const todayIso = isoDateString(new Date());
    const patch: {
      clinical_state: ClinicalState;
      clinical_cycle_anchor_iso?: string | null;
    } = { clinical_state: next };
    if (next !== 'cycling') {
      patch.clinical_cycle_anchor_iso = null;
    } else if (prev !== 'cycling') {
      const anchor = useAppStore.getState().clinicalCycleAnchorIso;
      patch.clinical_cycle_anchor_iso = anchor ?? todayIso;
    }
    setBusy(true);
    try {
      const { error } = await supabase.from('profiles').update(patch).eq('id', session.user.id);
      if (error) {
        Alert.alert('Could not save', error.message);
        return;
      }
      setClinicalState(next);
      if (next !== 'cycling') {
        setClinicalCycleAnchorIso(null);
      } else {
        setClinicalCycleAnchorIso(patch.clinical_cycle_anchor_iso ?? todayIso);
      }
    } finally {
      setBusy(false);
    }
  };

  const onClinicalChoice = (next: ClinicalState) => {
    if (!session?.user?.id || isGhost) return;
    if (next === clinicalState) return;
    if (next === 'loss' || next === 'postpartum') {
      Alert.alert(
        "We'll give this space",
        'Sardine pauses fertile-window and ovulation math here, so the dashboard will not nudge you about timing. Your calendar and notes stay with you. When you pick Charting as usual again, we start fresh from today — or from a new period you have already logged.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Continue', onPress: () => void applyClinicalState(next) },
        ],
      );
      return;
    }
    void applyClinicalState(next);
  };

  const applyTrackingGoal = async (g: TrackingGoal) => {
    if (!session?.user?.id || isGhost) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ tracking_goal: g })
        .eq('id', session.user.id);
      if (error) {
        Alert.alert('Could not save', error.message);
        return;
      }
      setTrackingGoal(g);
    } finally {
      setBusy(false);
    }
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
          ? result.zeroDataNote ??
            'No new Health Connect data was found in that range (or every field was already filled in Sardine).'
          : `Updated ${result.daysTouched} calendar day(s) across your manual log and/or nightly biometrics. Your cycle estimate was refreshed when new bleeding data was merged.`,
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
        await refreshWearablePermissionState();
      } else if (Platform.OS === 'ios') {
        const result = await healthKitRequestReadPermissions();
        if (!result.ok) {
          Alert.alert('Apple Health', result.reason);
          return;
        }
        await refreshWearablePermissionState();
      }
    } finally {
      setWearableBusy(false);
    }
  };

  const clearIntakeLastPeriodDate = () => {
    const uid = session?.user?.id;
    if (!uid || isGhost || !lastPeriodDateIso) return;
    Alert.alert(
      'Remove saved period start?',
      'This clears the first-day-of-last-period date from onboarding. Forecasts that depended only on that day will ease off until you log period flow on the calendar (or we add a way to set a new anchor).',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              try {
                const { error } = await supabase
                  .from('profiles')
                  .update({ last_period_date: null })
                  .eq('id', uid);
                if (error) {
                  Alert.alert('Could not save', error.message);
                  return;
                }
                hydrateCycleLengthFromProfile({
                  serverCycleLengthAvg: cycleLengthAvg,
                  isGhostMode: false,
                  lastPeriodDateIso: null,
                });
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
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

      <View style={styles.card}>
        <Text style={styles.cardTitle}>How Sardine works for you</Text>
        <Text style={styles.cardBody}>
          Right now tells us whether to run fertile-window and ovulation timing. What brings you here only changes
          reminders and how we talk about your chart — same choices as when you signed up.
        </Text>
        {isGhost ? (
          <Text style={styles.cardBody}>
            Sign in and turn off Ghost Mode to save these choices to your account.
          </Text>
        ) : (
          <>
            <Text style={[styles.rowLbl, { marginBottom: 8 }]}>Right now</Text>
            <View style={styles.segment}>
              {LIFE_STAGE_CHOICES.map(({ value: st, title }) => (
                <Pressable
                  key={st}
                  style={[styles.segBtn, st === clinicalState && styles.segBtnOn]}
                  onPress={() => onClinicalChoice(st)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={title}>
                  <Text style={[styles.segTxt, st === clinicalState && styles.segTxtOn]}>{title}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={[styles.rowLbl, { marginBottom: 8, marginTop: 14 }]}>What brings you here?</Text>
            <View style={styles.segment}>
              {WHY_HERE_OPTIONS.map(({ value: g, title }) => (
                <Pressable
                  key={g}
                  style={[styles.segBtn, g === trackingGoal && styles.segBtnOn]}
                  onPress={() => void applyTrackingGoal(g)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={title}>
                  <Text style={[styles.segTxt, g === trackingGoal && styles.segTxtOn]}>{title}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={[styles.cardHint, { marginTop: 12, marginBottom: 0 }]}>
              {WHY_HERE_OPTIONS.find((o) => o.value === trackingGoal)?.subtitle ?? ''}
            </Text>
            {trackingGoal === 'track_only' ? (
              <View style={{ marginTop: 16 }}>
                <View style={styles.row}>
                  <Text style={styles.rowLbl}>Daily BBT reminders</Text>
                  <Switch
                    value={trackOnlyBbtOptIn}
                    onValueChange={(v) => {
                      setTrackOnlyBbtOptIn(v);
                      setTrackOnlyBbtDailyRemindersOptIn(v);
                    }}
                    trackColor={{ true: colors.primarySageGreen, false: colors.chartGrid }}
                  />
                </View>
                <Text style={[styles.cardBody, { marginBottom: 0 }]}>
                  {`Off by default for "Just understanding my cycle." Turn on only if you want a daily nudge to log temperature. High-level heads-ups (for example period timing) can ship separately when we add scheduled alerts.`}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </View>

      {!isGhost && session?.user?.id ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Day-zero period start</Text>
          <Text style={styles.cardBody}>
            The first day of your last period from onboarding helps shade the calendar until your log and temps
            catch up. Remove it here if that date was entered wrong.
          </Text>
          <Text style={styles.rowLbl}>Saved on your profile</Text>
          <Text style={[styles.cardBody, { marginBottom: 0 }]}>
            {lastPeriodDateIso
              ? formatCalendarDate(parseIsoDate(lastPeriodDateIso), prefs.dateFormat, true)
              : 'None — use the calendar when you log flow.'}
          </Text>
          {lastPeriodDateIso ? (
            <Pressable
              style={[styles.secondaryOutlineBtn, { marginTop: 12 }]}
              onPress={clearIntakeLastPeriodDate}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Remove saved last period start date from profile">
              <Text style={styles.secondaryOutlineBtnTxt}>Remove saved date</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

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
              {Platform.OS === 'android' && wearableHcAnyRead ? (
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
  cardHint: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },
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
