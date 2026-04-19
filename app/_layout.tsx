import 'react-native-gesture-handler';
import '@/src/lib/backgroundScoreTask';

import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { useColorScheme } from '@/components/useColorScheme';
import { registerBackgroundScoreFetch } from '@/src/lib/backgroundScoreTask';
import { getAppLockEnabled, runInitialAppLockGate } from '@/src/lib/appLock';
import { initRevenueCat } from '@/src/lib/revenueCat';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import { colors } from '@/src/styles/theme';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();
WebBrowser.maybeCompleteAuthSession();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    ...FontAwesome.font,
  });

  const [appLockGateReady, setAppLockGateReady] = useState(() => !getAppLockEnabled());
  const [resumeBiometricBlocking, setResumeBiometricBlocking] = useState(false);
  const appStateRef = useRef(AppState.currentState);
  /** Suppresses a duplicate Face ID / fingerprint prompt right after cold-start unlock. */
  const resumeLockBypassUntilRef = useRef(0);

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (appLockGateReady) return;
    let cancelled = false;
    void runInitialAppLockGate().finally(() => {
      if (!cancelled) setAppLockGateReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [appLockGateReady]);

  useEffect(() => {
    initRevenueCat();
  }, []);

  useEffect(() => {
    const { setSession, setAuthHydrated } = useAppStore.getState();

    void supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthHydrated(true);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (loaded && appLockGateReady) {
      SplashScreen.hideAsync();
    }
  }, [loaded, appLockGateReady]);

  useEffect(() => {
    if (!appLockGateReady) return;
    resumeLockBypassUntilRef.current = Date.now() + 800;
  }, [appLockGateReady]);

  useEffect(() => {
    if (!loaded || !appLockGateReady) return;
    void registerBackgroundScoreFetch().catch(() => {});
  }, [loaded, appLockGateReady]);

  useEffect(() => {
    if (!loaded || !appLockGateReady) return;

    appStateRef.current = AppState.currentState;

    const sub = AppState.addEventListener('change', (nextState) => {
      const prevState = appStateRef.current;
      const hasSession = useAppStore.getState().session != null;

      if (
        getAppLockEnabled() &&
        hasSession &&
        nextState === 'active' &&
        prevState !== 'active' &&
        Date.now() >= resumeLockBypassUntilRef.current
      ) {
        setResumeBiometricBlocking(true);
        void runInitialAppLockGate().finally(() => {
          setResumeBiometricBlocking(false);
        });
      }

      appStateRef.current = nextState;
    });

    return () => sub.remove();
  }, [loaded, appLockGateReady]);

  if (!loaded || !appLockGateReady) {
    return null;
  }

  return <RootLayoutNav resumeBiometricBlocking={resumeBiometricBlocking} />;
}

function RootLayoutNav({ resumeBiometricBlocking }: { resumeBiometricBlocking: boolean }) {
  const colorScheme = useColorScheme();

  return (
    <GestureHandlerRootView style={styles.navRoot}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <View style={styles.navRoot}>
          <Stack screenOptions={{ headerShown: false }} />
          {resumeBiometricBlocking ? (
            <View
              style={[StyleSheet.absoluteFill, styles.resumeLockOverlay]}
              pointerEvents="auto"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          ) : null}
        </View>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  navRoot: {
    flex: 1,
  },
  resumeLockOverlay: {
    backgroundColor: colors.background,
  },
});
