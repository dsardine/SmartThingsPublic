import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { type Href, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatCalendarDate, isoDateString, parseIsoDate } from '@/src/lib/dateDisplay';
import { WHY_HERE_OPTIONS } from '@/src/lib/userCyclePreferencesCopy';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import { colors } from '@/src/styles/theme';
import type { TrackingGoal } from '@/src/types/database';

function defaultLmpDate(): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - 28);
  return d;
}

export default function OnboardingScreen() {
  const router = useRouter();
  const dateFormat = useAppStore((s) => s.preferences.dateFormat);
  const [lastPeriod, setLastPeriod] = useState(defaultLmpDate);
  const [cycleLen, setCycleLen] = useState('28');
  const [whyHere, setWhyHere] = useState<TrackingGoal>('track_only');
  const [busy, setBusy] = useState(false);
  const [showPicker, setShowPicker] = useState(Platform.OS === 'ios');

  const cycleNum = Math.round(Number(cycleLen.replace(/[^0-9.]/g, '')) || 0);

  const onSubmit = async () => {
    const cl = cycleNum;
    if (cl < 21 || cl > 50) {
      Alert.alert('Cycle length', 'Enter an average cycle length between 21 and 50 days.');
      return;
    }
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (lastPeriod > today) {
      Alert.alert('Date', 'Last period start cannot be in the future.');
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      Alert.alert('Session', 'Sign in again to continue setup.');
      return;
    }

    setBusy(true);
    try {
      const lastIso = isoDateString(lastPeriod);
      const { error } = await supabase.from('profiles').upsert(
        {
          id: user.id,
          last_period_date: lastIso,
          cycle_length_avg: cl,
          tracking_goal: whyHere,
          onboarding_completed: true,
        },
        { onConflict: 'id' },
      );

      if (error) {
        Alert.alert('Could not save', error.message);
        return;
      }
      useAppStore.getState().setTrackingGoal(whyHere);
      router.replace('/' as Href);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}>
          <View style={styles.hero}>
            <Text style={styles.kicker}>Welcome to Sardine</Text>
            <Text style={styles.title}>Let’s personalize your cycle</Text>
            <Text style={styles.lead}>
              A quick Day-zero snapshot helps us shade your likely fertile window until your temps
              and wearables catch up.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>First day of your last period</Text>
            <Text style={styles.cardHint}>Tap the date to open the calendar picker.</Text>
            {Platform.OS === 'web' ? (
              <TextInput
                style={styles.isoInput}
                value={isoDateString(lastPeriod)}
                onChangeText={(t) => {
                  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return;
                  const p = parseIsoDate(t);
                  if (Number.isNaN(p.getTime())) return;
                  setLastPeriod(p);
                }}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
              />
            ) : (
              <>
                <Pressable
                  style={styles.dateChip}
                  onPress={() => setShowPicker((s) => !s)}
                  accessibilityRole="button">
                  <Text style={styles.dateChipTxt}>
                    {formatCalendarDate(lastPeriod, dateFormat, true)}
                  </Text>
                </Pressable>
                {showPicker ? (
                  <DateTimePicker
                    value={lastPeriod}
                    mode="date"
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    themeVariant="light"
                    onChange={(ev, date) => {
                      if (Platform.OS === 'android') {
                        setShowPicker(false);
                      }
                      if (ev.type === 'dismissed') return;
                      if (date) setLastPeriod(date);
                    }}
                  />
                ) : null}
              </>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Average cycle length</Text>
            <Text style={styles.cardHint}>Typical days from one period start to the next (21–50).</Text>
            <TextInput
              style={styles.isoInput}
              value={cycleLen}
              onChangeText={setCycleLen}
              keyboardType="number-pad"
              maxLength={3}
              placeholder="28"
              placeholderTextColor={colors.textMuted}
            />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>What brings you here?</Text>
            <Text style={styles.cardHint}>
              This only changes reminders and how we talk about your chart — you can change it anytime in
              Preferences.
            </Text>
            <View style={styles.goalList}>
              {WHY_HERE_OPTIONS.map((opt) => {
                const on = opt.value === whyHere;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => setWhyHere(opt.value)}
                    style={[styles.goalRow, on && styles.goalRowOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={opt.title}>
                    <View style={[styles.goalDot, on && styles.goalDotOn]} />
                    <View style={styles.goalTextCol}>
                      <Text style={[styles.goalTitle, on && styles.goalTitleOn]}>{opt.title}</Text>
                      <Text style={styles.goalSubtitle}>{opt.subtitle}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <Pressable
            style={[styles.cta, busy && styles.ctaDisabled]}
            onPress={() => void onSubmit()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Save and continue">
            {busy ? (
              <ActivityIndicator color={colors.card} />
            ) : (
              <Text style={styles.ctaTxt}>Save & continue</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  scroll: {
    paddingHorizontal: 22,
    paddingBottom: 36,
    paddingTop: 12,
  },
  hero: {
    marginBottom: 22,
    backgroundColor: colors.fertileTint,
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.chartGrid,
  },
  kicker: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.primarySageGreen,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  title: {
    marginTop: 8,
    fontSize: 26,
    fontWeight: '900',
    color: colors.textDark,
    lineHeight: 32,
  },
  lead: {
    marginTop: 10,
    fontSize: 15,
    color: colors.textMuted,
    lineHeight: 22,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.chartGrid,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.textDark,
    marginBottom: 6,
  },
  cardHint: {
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: 14,
    lineHeight: 18,
  },
  dateChip: {
    alignSelf: 'flex-start',
    backgroundColor: colors.softLavender,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
  },
  dateChipTxt: { fontSize: 16, fontWeight: '800', color: colors.textDark },
  isoInput: {
    borderWidth: 1,
    borderColor: colors.chartGrid,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 17,
    fontWeight: '700',
    color: colors.textDark,
    backgroundColor: colors.background,
  },
  cta: {
    marginTop: 8,
    backgroundColor: colors.primarySageGreen,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  ctaDisabled: { opacity: 0.65 },
  ctaTxt: { color: colors.card, fontWeight: '900', fontSize: 17 },
  goalList: { gap: 10 },
  goalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.chartGrid,
    backgroundColor: colors.background,
  },
  goalRowOn: {
    borderColor: colors.primarySageGreen,
    backgroundColor: colors.fertileTint,
  },
  goalDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.chartGrid,
    marginTop: 2,
  },
  goalDotOn: {
    borderColor: colors.primarySageGreen,
    backgroundColor: colors.primarySageGreen,
  },
  goalTextCol: { flex: 1 },
  goalTitle: { fontSize: 16, fontWeight: '800', color: colors.textDark },
  goalTitleOn: { color: colors.primarySageGreen },
  goalSubtitle: {
    marginTop: 4,
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
  },
});
