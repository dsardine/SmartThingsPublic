import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatDaysToOvulation, parseInsightText } from '@/src/lib/cachedInsight';
import { MAX_BASELINE_ROWS } from '@/src/lib/nocturnalBiometrics';
import { supabase } from '@/src/lib/supabase';
import { colors } from '@/src/styles/theme';

type ScoreResult = {
  conception_score: number;
  is_estimate: boolean;
  insight_text: string;
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
  return {
    conception_score: n.conception_score,
    is_estimate: n.is_estimate,
    insight_text: parsed.narrative,
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
  const { width } = useWindowDimensions();
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

  const loadCachedScore = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data: cached } = await supabase
      .from('cached_insight')
      .select('conception_score, is_estimate, insight_text')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!cached) {
      setScore(null);
      setEstimatedOvulation(null);
      return;
    }
    const parsedRow = rowToScore(cached as Record<string, unknown>);
    if (parsedRow) setScore(parsedRow);
    const meta = parseInsightText(cached.insight_text);
    setEstimatedOvulation(meta.estimatedOvulationDate);
  }, []);

  useEffect(() => {
    void loadCachedScore();
  }, [loadCachedScore]);

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
        .select('has_new_biometrics')
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

      if (!profile.has_new_biometrics) {
        await loadCachedScore();
        return;
      }

      const { data: bioRows, error: bioError } = await supabase
        .from('biometrics')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(MAX_BASELINE_ROWS);

      if (bioError) {
        Alert.alert('Biometrics', bioError.message);
        return;
      }

      if ((bioRows ?? []).length === 0) {
        Alert.alert(
          'Biometrics',
          'No biometrics rows yet. Add data before generating a score.',
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
            setEstimatedOvulation(meta.estimatedOvulationDate);
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
        Alert.alert('Score', fnError.message);
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

  const daysLabel = formatDaysToOvulation(estimatedOvulation);

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
          <Text style={styles.headline}>Fertility pulse</Text>
          <Text style={styles.subtitle}>
            Your score, story, and countdown — without the spreadsheet trauma.
          </Text>
        </View>

        {score?.is_estimate === true ? (
          <View style={styles.estimateBanner}>
            <Text style={styles.estimateBannerText}>
              Wearable data thin or estimating — take this read with a grain of sea salt.
            </Text>
          </View>
        ) : null}

        <View style={styles.scoreCard}>
          <Text style={styles.cardLabel}>Fertility score</Text>
          <Text style={styles.scoreHuge}>
            {score != null ? `${score.conception_score}` : '—'}
          </Text>
          <Text style={styles.cardHint}>0–100 · higher suggests stronger cycle signal</Text>
        </View>

        <View style={styles.rowCards}>
          <View style={styles.miniCard}>
            <Text style={styles.miniLabel}>Days to ovulation</Text>
            <Text style={styles.miniValue}>{daysLabel}</Text>
          </View>
          <View style={styles.miniCard}>
            <Text style={styles.miniLabel}>Next beat</Text>
            <Text style={styles.miniValue}>
              {estimatedOvulation ? 'Lock the pattern' : 'Log temps & RHR'}
            </Text>
          </View>
        </View>

        <View style={styles.summaryCard}>
          <Text style={styles.cardLabel}>AI summary</Text>
          <Text style={styles.summaryBody}>
            {score?.insight_text ??
              'Tap below when you have fresh biometrics — we will run the rules (free) or Gemini (premium) and drop the story here.'}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Update fertility score"
          disabled={loading}
          onPress={checkMyScore}
          style={({ pressed }) => [
            styles.cta,
            pressed && styles.ctaPressed,
            loading && styles.ctaDisabled,
          ]}>
          {loading ? (
            <ActivityIndicator color={colors.card} />
          ) : (
            <Text style={styles.ctaText}>
              Update My Score — the biometrics oracle is bored without you
            </Text>
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
  cardLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  scoreHuge: {
    fontSize: 52,
    fontWeight: '900',
    color: colors.primarySageGreen,
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
