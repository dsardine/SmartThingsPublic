import { Stack } from 'expo-router';

import { colors } from '@/src/styles/theme';

export default function MenuLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerTintColor: colors.textDark,
        headerStyle: { backgroundColor: colors.background },
        contentStyle: { backgroundColor: colors.background },
      }}>
      <Stack.Screen name="index" options={{ title: 'Menu' }} />
    </Stack>
  );
}
