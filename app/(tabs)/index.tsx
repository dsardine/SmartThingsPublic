import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { type Href, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  formatDaysToOvulation,
  parseInsightText,
  SCORE_ATTRIBUTION_SYMPTOTHERMAL,
  SCORE_ATTRIBUTION_WEARABLES,
} from '@/src/lib/cachedInsight';
import {
  HEALTH_CONNECT_SOFT_NUDGE_DISMISSED_KEY,
  healthConnectEnsureInitialized,
  healthConnectHasAllReadPermissions,
} from '@/src/lib/healthConnectAndroid';
import {
  HEALTH_KIT_SOFT_NUDGE_DISMISSED_KEY,
  healthKitEnsureAvailable,
  healthKitHasAllReadPermissions,
} from '@/src/lib/healthKitIOS';
import { appStorage } from '@/src/lib/storage';
import { formatNextPeriodCountdown } from '@/src/lib/periodCountdown';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import { colors } from '@/src/styles/theme';
import type { ClinicalState, TrackingGoal } from '@/src/types/database';

/**
 * Backend `conception_score` rises with fertile signal; for "avoid" we show the complement so the
 * dashboard reads as calmer when vitals look less like a peak-fertile stretch.
 */
function displayedDashboardScore(raw: number | null | undefined, goal: TrackingGoal): string | null {
  if (raw == null || !Number.isFinite(Number(raw))) return null;
  const n = Math.round(Number(raw));
  if (goal === 'avoid') {
    return `${Math.max(0, Math.min(100, 100 - n))}`;
  }
  return `${n}`;
}

type ScoreResult = {
  conception_score: number;
  is_estimate: boolean;
  insight_text: string;
  scoreAttribution: string | null;
  statisticalPeriodOnly: boolean;
};

function rowToScore(n: Record<string, unknown>): ScoreResult | null {
  if (
    typeof n.conception_score !== 'number' ||
    typeof n.is_estimate !== 'boolean' ||
    typeof n.insight_text !== 'string'
  ) {
    return null;
  }
  const parsed = parseInsightText(n.insight_text);
  const scoreAttribution =
    parsed.scoreBasis === 'wearables'
      ? SCORE_ATTRIBUTION_WEARABLES
      : parsed.scoreBasis === 'symptothermal'
        ? SCORE_ATTRIBUTION_SYMPTOTHERMAL
        : null;
  return {
    conception_score: n.conception_score,
    is_estimate: n.is_estimate,
    insight_text: parsed.narrativeBody,
    scoreAttribution,
    statisticalPeriodOnly: parsed.statisticalPeriodOnly,
  };
}

function waitForChannelSubscribed(channel: RealtimeChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        if (!settled) {
          settled = true;
          resolve();
        }
        return;
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (!settled) {
          settled = true;
          reject(err ?? new Error(`Channel status: ${status}`));
        }
      }
    });
  });
}

export default function FertilityDashboardScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const clinicalState = useAppStore((s) => s.clinicalState);
  const trackingGoal = useAppStore((s) => s.trackingGoal);
  const lastPeriodDateIso = useAppStore((s) => s.lastPeriodDateIso);
  const cycleLengthAvg = useAppStore((s) => s.cycleLengthAvg);
  const isGhostModeEnabled = useAppStore((s) => s.isGhostModeEnabled);
  const hydrateCycleLengthFromProfile = useAppStore((s) => s.hydrateCycleLengthFromProfile);
  const [loading, setLoading] = useState(false);
  const [score, setScore] = useState<ScoreResult | null>(null);
  const [estimatedOvulation, setEstimatedOvulation] = useState<string | null>(null);
  const pendingInsightChannel = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    return () => {
      const ch = pendingInsightChannel.current;
      if (ch) {
        supabase.removeChannel(ch);
        pendingInsightChannel.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (trackingGoal === 'track_only') return;
    if (clinicalState !== 'cycling') return;
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return;
    const dismissKey =
      Platform.OS === 'ios' ? HEALTH_KIT_SOFT_NUDGE_DISMISSED_KEY : HEALTH_CONNECT_SOFT_NUDGE_DISMISSED_KEY;
    if (appStorage.getBoolean(dismissKey)) return;
    let cancelled = false;
    void (async () => {
      if (Platform.OS === 'android') {
        const init = await healthConnectEnsureInitialized();
        if (cancelled || !init.ok) return;
        const has = await healthConnectHasAllReadPermissions();
        if (cancelled || has) return;
        Alert.alert(
          'Connect Google Health Connect',
          'Allow read access so Sardine can use resting heart rate, HRV, breathing rate, and basal temperature from your wearables. You can also connect any time from the menu.',
          [
            {
              text: 'Not now',
              style: 'cancel',
              onPress: () => appStorage.set(dismissKey, true),
            },
            { text: 'Open menu', onPress: () => router.push('/menu' as Href) },
          ],
        );
        return;
      }
      const init = await healthKitEnsureAvailable();
      if (cancelled || !init.ok) return;
      const has = await healthKitHasAllReadPermissions();
      if (cancelled || has) return;
      Alert.alert(
        'Connect Apple Health',
        'Allow read access so Sardine can use basal temperature, HRV, resting heart rate, and respiratory rate from Apple Health. You can also connect any time from the menu.',
        [
          {
            text: 'Not now',
            style: 'cancel',
            onPress: () => appStorage.set(dismissKey, true),
          },
          { text: 'Open menu', onPress: () => router.push('/menu' as Href) },
        ],
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [router, trackingGoal, clinicalState]);

  const loadCachedScore = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const [{ data: cached }, { data: prof }] = await Promise.all([
      supabase
        .from('cached_insight')
        .select('conception_score, is_estimate, insight_text')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('profiles')
        .select('last_period_date, cycle_length_avg, clinical_state')
        .eq('id', user.id)
        .maybeSingle(),
    ]);
    if (prof) {
      const pr = prof as {
        last_period_date?: string | null;
        cycle_length_avg?: number | null;
        clinical_state?: ClinicalState | null;
      };
      const serverCl =
        typeof pr.cycle_length_avg === 'number' && Number.isFinite(pr.cycle_length_avg)
          ? Math.round(pr.cycle_length_avg)
          : 28;
      hydrateCycleLengthFromProfile({
        serverCycleLengthAvg: serverCl,
        isGhostMode: isGhostModeEnabled,
        lastPeriodDateIso: typeof pr.last_period_date === 'string' ? pr.last_period_date : null,
      });
    }
    if (!cached) {
      setScore(null);
      setEstimatedOvulation(null);
      return;
    }
    const parsedRow = rowToScore(cached as Record<string, unknown>);
    if (parsedRow) setScore(parsedRow);
    const meta = parseInsightText(cached.insight_text);
    const prRow = prof as {
      clinical_state?: ClinicalState | null;
    } | null;
    const profileCs = prRow?.clinical_state ?? null;
    const effectiveCs: ClinicalState = profileCs ?? clinicalState;
    setEstimatedOvulation(effectiveCs === 'cycling' ? meta.estimatedOvulationDate : null);
  }, [hydrateCycleLengthFromProfile, isGhostModeEnabled, clinicalState]);

  useEffect(() => {
    void loadCachedScore();
  }, [loadCachedScore, clinicalState]);

  const checkMyScore = useCallback(async () => {
    try {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();
      if (authError || !user) {
        Alert.alert('Sign in required', 'Please sign in to view your score.');
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('clinical_state, tracking_goal')
        .eq('id', user.id)
        .maybeSingle();

      if (profileError) {
        Alert.alert('Profile', profileError.message);
        return;
      }
      if (profile == null) {
        Alert.alert(
          'Profile',
          'No profile row found. Ensure your account has a profiles record.',
        );
        return;
      }

      if (profile.clinical_state != null && profile.clinical_state !== 'cycling') {
        await loadCachedScore();
        Alert.alert(
          'Clinical mode paused',
          'Fertile-window and ovulation scoring stay off while you are not charting as usual. Calendar and logging still work; switch back under Preferences when you want algorithms again.',
        );
        return;
      }

      setLoading(true);

      const channel = supabase
        .channel(`cached_insight_gen_${user.id}_${Date.now()}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'cached_insight',
            filter: `user_id=eq.${user.id}`,
          },
          (change) => {
            const parsed = rowToScore(change.new as Record<string, unknown>);
            if (parsed == null) return;
            setScore(parsed);
            const meta = parseInsightText(
              (change.new as { insight_text?: string }).insight_text ?? '',
            );
            setEstimatedOvulation(
              useAppStore.getState().clinicalState === 'cycling'
                ? meta.estimatedOvulationDate
                : null,
            );
            setLoading(false);
            supabase.removeChannel(channel);
            if (pendingInsightChannel.current === channel) {
              pendingInsightChannel.current = null;
            }
          },
        );

      pendingInsightChannel.current = channel;

      try {
        await waitForChannelSubscribed(channel);
      } catch (e) {
        pendingInsightChannel.current = null;
        supabase.removeChannel(channel);
        setLoading(false);
        Alert.alert(
          'Realtime',
          e instanceof Error ? e.message : 'Could not subscribe to updates.',
        );
        return;
      }

      const { error: fnError } = await supabase.functions.invoke('generate-score', {
        body: {},
      });

      if (fnError) {
        pendingInsightChannel.current = null;
        supabase.removeChannel(channel);
        setLoading(false);
        let detail = fnError.message;
        if (fnError instanceof FunctionsHttpError) {
          try {
            const raw = await fnError.context.clone().text();
            if (raw) {
              try {
                const j = JSON.parse(raw) as {
                  error?: string;
                  message?: string;
                  details?: string;
                  hint?: string;
                };
                const parts = [j.message, j.details, j.hint, j.error].filter(
                  (s): s is string => typeof s === 'string' && s.trim() !== '',
                );
                detail = parts.length > 0 ? parts.join('\n') : raw;
              } catch {
                detail = raw.length > 420 ? `${raw.slice(0, 420)}…` : raw;
              }
            }
          } catch {
            /* keep fnError.message */
          }
        }
        Alert.alert('Score', detail);
        return;
      }
    } catch (e) {
      setLoading(false);
      const ch = pendingInsightChannel.current;
      if (ch) {
        supabase.removeChannel(ch);
        pendingInsightChannel.current = null;
      }
      Alert.alert('Score', e instanceof Error ? e.message : 'Something went wrong.');
    }
  }, [loadCachedScore]);

  const periodOnlyPulse = useMemo(
    () =>
      clinicalState === 'cycling' &&
      trackingGoal !== 'track_only' &&
      score?.statisticalPeriodOnly === true,
    [clinicalState, trackingGoal, score?.statisticalPeriodOnly],
  );

  const dashboardCopy = useMemo(() => {
    if (clinicalState !== 'cycling') {
      return {
        primaryColLabel: 'Fertile timing',
        primaryColValue: '—',
        nextBeat: 'Paused',
        cta: 'Algorithms paused — Calendar or Preferences',
        showEstimateBanner: false,
      };
    }
    if (trackingGoal === 'conceive') {
      const po = score?.statisticalPeriodOnly === true;
      return {
        primaryColLabel: po ? 'Est. ovulation (approx.)' : 'Days to ovulation',
        primaryColValue: po
          ? estimatedOvulation
            ? `${formatDaysToOvulation(estimatedOvulation)} · estimate`
            : formatDaysToOvulation(estimatedOvulation)
          : formatDaysToOvulation(estimatedOvulation),
        nextBeat: estimatedOvulation
          ? po
            ? 'Estimated window'
            : 'Peak fertility focus'
          : 'Log morning BBT',
        cta: 'Update My Score — peak fertility & BBT read',
        showEstimateBanner: score?.is_estimate === true || po,
      };
    }
    if (trackingGoal === 'avoid') {
      const po = score?.statisticalPeriodOnly === true;
      return {
        primaryColLabel: po ? 'Est. ovulation (approx.)' : 'Days to ovulation',
        primaryColValue: po
          ? estimatedOvulation
            ? `${formatDaysToOvulation(estimatedOvulation)} · estimate`
            : formatDaysToOvulation(estimatedOvulation)
          : formatDaysToOvulation(estimatedOvulation),
        nextBeat: estimatedOvulation
          ? po
            ? 'Estimated window'
            : 'Ovulation timing'
          : 'Fertile window watch',
        cta: 'Update My Score — fertile window & confirmation',
        showEstimateBanner: score?.is_estimate === true || po,
      };
    }
    return {
      primaryColLabel: 'Cycle timing',
      primaryColValue: formatDaysToOvulation(estimatedOvulation),
      nextBeat: estimatedOvulation ? 'Period rhythm' : 'Log bleeding for forecasts',
      cta: 'Update My Score — period rhythm snapshot',
      showEstimateBanner: false,
    };
  }, [clinicalState, trackingGoal, estimatedOvulation, score?.is_estimate, score?.statisticalPeriodOnly]);

  const headerCopy = useMemo(() => {
    if (clinicalState !== 'cycling') {
      return {
        headline: 'Cycle pulse',
        subtitle:
          'When you are ready to chart again, your headline and score framing pick up from what you chose under What brings you here.',
      };
    }
    if (trackingGoal === 'conceive') {
      return {
        headline: 'Fertility pulse',
        subtitle:
          'Timing, story, and countdown tuned for trying to conceive — without the spreadsheet trauma.',
      };
    }
    if (trackingGoal === 'avoid') {
      return {
        headline: 'Rhythm & boundaries',
        subtitle:
          'The main number is flipped: higher reads calmer when vitals look less like a peak-fertile stretch. Same science, wording that matches avoiding pregnancy.',
      };
    }
    return {
      headline: 'Cycle pulse',
      subtitle: 'Period-friendly read — lighter on daily nudges, still clear on what the data suggests.',
    };
  }, [clinicalState, trackingGoal]);

  const scoreCardCopy = useMemo(() => {
    if (clinicalState !== 'cycling') {
      return {
        label: 'Score',
        hint: 'Algorithms paused — no live score while you are not charting as usual.',
      };
    }
    if (trackingGoal === 'conceive') {
      if (periodOnlyPulse) {
        return {
          label: 'Estimated pulse',
          hint: '0–70 cap when only period flow is on the chart — add BBT or cervical fluid to tighten the read.',
        };
      }
      return {
        label: 'Fertility score',
        hint: '0–100 · higher suggests a stronger fertile-window signal from temps and wearables.',
      };
    }
    if (trackingGoal === 'avoid') {
      if (periodOnlyPulse) {
        return {
          label: 'Cycle estimate',
          hint: '0–70 cap on the raw read when only bleeding is logged; higher still reads calmer once inverted.',
        };
      }
      return {
        label: 'Calm score',
        hint: '0–100 · higher means vitals look more settled versus a peak-fertile spike (inverted from the raw read).',
      };
    }
    return {
      label: 'Cycle countdown',
      hint: 'Based on your last logged period start and typical cycle length — update the calendar anytime.',
    };
  }, [clinicalState, trackingGoal, periodOnlyPulse]);

  const displayedScore = useMemo(
    () => displayedDashboardScore(score?.conception_score, trackingGoal),
    [score?.conception_score, trackingGoal],
  );

  const showTrackOnlyCountdown =
    clinicalState === 'cycling' && trackingGoal === 'track_only';

  const countdownLabel = useMemo(
    () => formatNextPeriodCountdown(lastPeriodDateIso, cycleLengthAvg),
    [lastPeriodDateIso, cycleLengthAvg],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: Math.max(20, width * 0.06) },
        ]}
        keyboardShouldPersistTaps="handled">
        <View style={styles.headerBlock}>
          <Text style={styles.kicker}>Sardine</Text>
          <Text style={styles.headline}>{headerCopy.headline}</Text>
          <Text style={styles.subtitle}>{headerCopy.subtitle}</Text>
        </View>

        {clinicalState !== 'cycling' ? (
          <View style={styles.pausedBanner}>
            <Text style={styles.pausedBannerText}>
              Clinical mode is paused — fertile-window and ovulation math stay off until you choose
              charting as usual again in Preferences.
            </Text>
          </View>
        ) : null}

        {dashboardCopy.showEstimateBanner ? (
          <View style={styles.estimateBanner}>
            <Text style={styles.estimateBannerText}>
              {score?.statisticalPeriodOnly
                ? 'Statistical mode — only period flow is logged so far. Add BBT or wearable vitals for a tighter read.'
                : 'Wearable data thin or estimating — take this read with a grain of sea salt.'}
            </Text>
          </View>
        ) : null}

        <View
          style={[
            styles.scoreCard,
            showTrackOnlyCountdown && styles.scoreCardTrackOnly,
            periodOnlyPulse && styles.scoreCardStatistical,
          ]}>
          <Text style={styles.cardLabel}>{scoreCardCopy.label}</Text>
          {showTrackOnlyCountdown ? (
            <Text style={styles.countdownHuge}>{countdownLabel}</Text>
          ) : (
            <View style={styles.scoreNumberRow}>
              <Text
                style={[styles.scoreHuge, periodOnlyPulse && styles.scoreHugeStatistical]}>
                {displayedScore ?? '—'}
              </Text>
              {periodOnlyPulse ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="About this cycle estimate"
                  onPress={() =>
                    Alert.alert(
                      'Cycle estimate',
                      'This estimate is based on your cycle averages. Log biometrics for real-time accuracy.',
                    )
                  }
                  style={styles.scoreInfoBtn}>
                  <Ionicons
                    name="information-circle-outline"
                    size={24}
                    color={colors.pulseEstimateMuted}
                  />
                </Pressable>
              ) : null}
            </View>
          )}
          <Text style={styles.cardHint}>{scoreCardCopy.hint}</Text>
        </View>

        <View style={styles.rowCards}>
          <View style={styles.miniCard}>
            <Text style={styles.miniLabel}>{dashboardCopy.primaryColLabel}</Text>
            <Text style={styles.miniValue}>{dashboardCopy.primaryColValue}</Text>
          </View>
          <View style={styles.miniCard}>
            <Text style={styles.miniLabel}>Next beat</Text>
            <Text style={styles.miniValue}>{dashboardCopy.nextBeat}</Text>
          </View>
        </View>

        <View style={styles.summaryCard}>
          <Text style={styles.cardLabel}>AI summary</Text>
          {score?.scoreAttribution ? (
            <Text
              style={[
                styles.scoreAttribution,
                showTrackOnlyCountdown && styles.scoreAttributionTrackOnly,
              ]}>
              {score.scoreAttribution}
            </Text>
          ) : null}
          <Text style={styles.summaryBody}>
            {score?.insight_text ??
              'Tap below when you have fresh biometrics — we will run the rules (free) or Gemini (premium) and drop the story here.'}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            trackingGoal === 'avoid'
              ? 'Update cycle score'
              : trackingGoal === 'conceive'
                ? 'Update fertility score'
                : 'Update cycle read'
          }
          disabled={loading || clinicalState !== 'cycling'}
          onPress={checkMyScore}
          style={({ pressed }) => [
            styles.cta,
            showTrackOnlyCountdown && styles.ctaTrackOnly,
            pressed && styles.ctaPressed,
            (loading || clinicalState !== 'cycling') && styles.ctaDisabled,
          ]}>
          {loading ? (
            <ActivityIndicator color={colors.card} />
          ) : (
            <Text style={styles.ctaText}>{dashboardCopy.cta}</Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    paddingTop: 12,
    paddingBottom: 40,
  },
  headerBlock: {
    marginBottom: 20,
  },
  kicker: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: 6,
  },
  headline: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.textDark,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 22,
    color: colors.textMuted,
    maxWidth: 360,
  },
  pausedBanner: {
    backgroundColor: colors.softLavender,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.chartGrid,
  },
  pausedBannerText: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textDark,
    fontWeight: '600',
  },
  estimateBanner: {
    backgroundColor: colors.softLavender,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  estimateBannerText: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textDark,
    fontWeight: '600',
  },
  scoreCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 20,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: colors.chartGrid,
  },
  scoreCardTrackOnly: {
    borderLeftWidth: 5,
    borderLeftColor: colors.cycleNeutralTeal,
    borderColor: colors.chartGrid,
  },
  cardLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  scoreNumberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  scoreInfoBtn: {
    padding: 4,
  },
  scoreCardStatistical: {
    borderLeftWidth: 5,
    borderLeftColor: colors.pulseEstimateMuted,
  },
  scoreHuge: {
    fontSize: 52,
    fontWeight: '900',
    color: colors.primarySageGreen,
  },
  scoreHugeStatistical: {
    color: colors.pulseEstimateMuted,
  },
  countdownHuge: {
    fontSize: 26,
    lineHeight: 34,
    fontWeight: '800',
    color: colors.cycleNeutralTeal,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 2,
  },
  cardHint: {
    marginTop: 6,
    fontSize: 13,
    color: colors.textMuted,
  },
  rowCards: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 14,
  },
  miniCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.chartGrid,
  },
  miniLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    marginBottom: 6,
  },
  miniValue: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textDark,
  },
  summaryCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 18,
    marginBottom: 22,
    borderWidth: 1,
    borderColor: colors.chartGrid,
  },
  scoreAttribution: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.primarySageGreen,
    lineHeight: 20,
    marginBottom: 10,
  },
  scoreAttributionTrackOnly: {
    color: colors.cycleNeutralTeal,
  },
  summaryBody: {
    fontSize: 16,
    lineHeight: 24,
    color: colors.textDark,
  },
  cta: {
    backgroundColor: colors.mutedCoral,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
  },
  ctaTrackOnly: {
    backgroundColor: colors.cycleNeutralTeal,
  },
  ctaPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.99 }],
  },
  ctaDisabled: {
    opacity: 0.75,
  },
  ctaText: {
    color: colors.card,
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 22,
  },
});
