import React, { useEffect } from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { type Href, Redirect, Tabs, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { useClientOnlyValue } from '@/components/useClientOnlyValue';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import { colors } from '@/src/styles/theme';
import type { DateFormat, FirstDayOfWeek, TemperatureUnit } from '@/src/types/database';

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

  useEffect(() => {
    if (!session?.user?.id) return;
    void (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('temperature_unit, first_day_of_week, date_format')
        .eq('id', session.user.id)
        .maybeSingle();
      if (error || !data) return;
      const row = data as {
        temperature_unit?: TemperatureUnit;
        first_day_of_week?: FirstDayOfWeek;
        date_format?: DateFormat;
      };
      hydratePreferences({
        temperatureUnit: row.temperature_unit === 'C' ? 'C' : 'F',
        firstDayOfWeek: row.first_day_of_week === 'Monday' ? 'Monday' : 'Sunday',
        dateFormat: row.date_format === 'DD/MM/YYYY' ? 'DD/MM/YYYY' : 'MM/DD/YYYY',
      });
    })();
  }, [session?.user?.id, hydratePreferences]);

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
