import React, { useEffect, useState } from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { type Href, Redirect, Tabs, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { useClientOnlyValue } from '@/components/useClientOnlyValue';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import { colors } from '@/src/styles/theme';
import type {
  ClinicalState,
  DateFormat,
  FirstDayOfWeek,
  TemperatureUnit,
  TrackingGoal,
} from '@/src/types/database';

function TabBarIcon(props: {
  name: React.ComponentProps<typeof FontAwesome>['name'];
  color: string;
}) {
  return <FontAwesome size={28} style={{ marginBottom: -3 }} {...props} />;
}

export default function TabLayout() {
  const router = useRouter();
  const authHydrated = useAppStore((s) => s.authHydrated);
  const session = useAppStore((s) => s.session);
  const hydratePreferences = useAppStore((s) => s.hydratePreferences);
  const hydrateCycleLengthFromProfile = useAppStore((s) => s.hydrateCycleLengthFromProfile);
  const hydrateClinicalFromProfile = useAppStore((s) => s.hydrateClinicalFromProfile);
  const isGhostModeEnabled = useAppStore((s) => s.isGhostModeEnabled);
  const [profileResolved, setProfileResolved] = useState(false);
  const [allowTabs, setAllowTabs] = useState(false);

  useEffect(() => {
    if (!session?.user?.id) {
      setProfileResolved(false);
      setAllowTabs(false);
      return;
    }

    let cancelled = false;
    setProfileResolved(false);
    setAllowTabs(false);

    void (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select(
          'temperature_unit, first_day_of_week, date_format, bbt_time_format, onboarding_completed, last_period_date, cycle_length_avg, clinical_state, tracking_goal, clinical_cycle_anchor_iso',
        )
        .eq('id', session.user.id)
        .maybeSingle();

      if (cancelled) return;

      if (error) {
        // Fail closed: never open the main app without a confirmed profile gate.
        // (e.g. missing DB columns or RLS misconfiguration used to set allowTabs true and skip onboarding.)
        router.replace('/onboarding' as Href);
        setAllowTabs(false);
        setProfileResolved(true);
        return;
      }

      if (!data) {
        router.replace('/onboarding' as Href);
        setAllowTabs(false);
        setProfileResolved(true);
        return;
      }

      const row = data as {
        temperature_unit?: TemperatureUnit;
        first_day_of_week?: FirstDayOfWeek;
        date_format?: DateFormat;
        bbt_time_format?: string | null;
        onboarding_completed?: boolean;
        cycle_length_avg?: number | null;
        last_period_date?: string | null;
        clinical_state?: ClinicalState | null;
        tracking_goal?: TrackingGoal | null;
        clinical_cycle_anchor_iso?: string | null;
      };

      hydratePreferences({
        temperatureUnit: row.temperature_unit === 'C' ? 'C' : 'F',
        firstDayOfWeek: row.first_day_of_week === 'Monday' ? 'Monday' : 'Sunday',
        dateFormat: row.date_format === 'DD/MM/YYYY' ? 'DD/MM/YYYY' : 'MM/DD/YYYY',
        bbtTimeFormat: row.bbt_time_format === '24h' ? '24h' : '12h',
      });

      const serverCl =
        typeof row.cycle_length_avg === 'number' && Number.isFinite(row.cycle_length_avg)
          ? Math.round(row.cycle_length_avg)
          : 28;
      hydrateCycleLengthFromProfile({
        serverCycleLengthAvg: serverCl,
        isGhostMode: isGhostModeEnabled,
        lastPeriodDateIso:
          typeof row.last_period_date === 'string' ? row.last_period_date : null,
      });

      hydrateClinicalFromProfile({
        clinical_state: row.clinical_state ?? undefined,
        tracking_goal: row.tracking_goal ?? undefined,
        clinical_cycle_anchor_iso: row.clinical_cycle_anchor_iso ?? undefined,
      });

      if (row.onboarding_completed !== true) {
        router.replace('/onboarding' as Href);
        setAllowTabs(false);
        setProfileResolved(true);
        return;
      }

      setAllowTabs(true);
      setProfileResolved(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    session?.user?.id,
    hydratePreferences,
    hydrateCycleLengthFromProfile,
    hydrateClinicalFromProfile,
    isGhostModeEnabled,
    router,
  ]);

  if (!authHydrated) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: colors.background,
        }}>
        <ActivityIndicator size="large" color={colors.primarySageGreen} />
      </View>
    );
  }

  if (!session) {
    return <Redirect href="/login" />;
  }

  if (!profileResolved) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: colors.background,
        }}>
        <ActivityIndicator size="large" color={colors.primarySageGreen} />
      </View>
    );
  }

  if (!allowTabs) {
    return null;
  }

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primarySageGreen,
        headerShown: useClientOnlyValue(false, true),
        headerTintColor: colors.textDark,
        headerStyle: { backgroundColor: colors.background },
        headerRight: () => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open menu"
            onPress={() => router.push('/menu' as Href)}
            hitSlop={12}
            style={{ marginRight: 14, padding: 4 }}>
            <FontAwesome name="bars" size={22} color={colors.textDark} />
          </Pressable>
        ),
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color }) => <TabBarIcon name="heartbeat" color={color} />,
        }}
      />
      <Tabs.Screen
        name="graphs"
        options={{
          title: 'Biometrics',
          tabBarIcon: ({ color }) => <TabBarIcon name="line-chart" color={color} />,
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: 'Calendar',
          tabBarIcon: ({ color }) => <TabBarIcon name="calendar" color={color} />,
        }}
      />
    </Tabs>
  );
}
