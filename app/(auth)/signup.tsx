import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type Href, Link, useRouter } from 'expo-router';

import { signInWithGoogle } from '@/src/lib/googleAuth';
import { supabase } from '@/src/lib/supabase';
import { colors } from '@/src/styles/theme';

export default function SignupScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const formLocked = busy || googleBusy;

  const onSubmit = async () => {
    setError(null);
    setInfo(null);
    const trimmed = email.trim();
    if (!trimmed || !password) {
      setError('Enter email and password.');
      return;
    }
    if (password.length < 8) {
      setError('Use at least 8 characters for the password.');
      return;
    }
    setBusy(true);
    try {
      const { error: signErr } = await supabase.auth.signUp({
        email: trimmed,
        password,
      });
      if (signErr) {
        setError(signErr.message);
        return;
      }
      setInfo('Check your email to confirm, then sign in.');
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = async () => {
    setError(null);
    setInfo(null);
    setGoogleBusy(true);
    try {
      const { error: gErr } = await signInWithGoogle();
      if (gErr) {
        setError(gErr.message);
        return;
      }
      router.replace('/' as Href);
    } finally {
      setGoogleBusy(false);
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
          <Text style={styles.title}>Create account</Text>
          <Text style={styles.sub}>Uses your Supabase project (same URL as the app).</Text>

          <Pressable
            style={[styles.googleBtn, formLocked && styles.btnDisabled]}
            onPress={() => void onGoogle()}
            disabled={formLocked}
            accessibilityRole="button"
            accessibilityLabel="Continue with Google">
            {googleBusy ? (
              <ActivityIndicator color={colors.textDark} />
            ) : (
              <Text style={styles.googleBtnTxt}>Continue with Google</Text>
            )}
          </Pressable>

          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>or email</Text>
            <View style={styles.orLine} />
          </View>

          <View style={styles.field}>
            <Text style={styles.lbl}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              returnKeyType="next"
              editable={!formLocked}
              placeholder="you@example.com"
              placeholderTextColor={colors.textMuted}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.lbl}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="newPassword"
              autoComplete="password-new"
              returnKeyType="done"
              onSubmitEditing={() => void onSubmit()}
              editable={!formLocked}
              placeholder="At least 8 characters"
              placeholderTextColor={colors.textMuted}
            />
          </View>

          {error ? <Text style={styles.err}>{error}</Text> : null}
          {info ? <Text style={styles.info}>{info}</Text> : null}

          <Pressable
            style={[styles.btn, formLocked && styles.btnDisabled]}
            onPress={() => void onSubmit()}
            disabled={formLocked}
            accessibilityRole="button"
            accessibilityLabel="Create account">
            {busy && !googleBusy ? (
              <ActivityIndicator color={colors.card} />
            ) : (
              <Text style={styles.btnTxt}>Sign up</Text>
            )}
          </Pressable>

          <Link href="/login" asChild>
            <Pressable style={styles.linkWrap} accessibilityRole="link">
              <Text style={styles.link}>Already have an account? Sign in</Text>
            </Pressable>
          </Link>

          {info ? (
            <Pressable style={styles.secondary} onPress={() => router.replace('/login' as Href)}>
              <Text style={styles.secondaryTxt}>Go to sign in</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 40,
    justifyContent: 'center',
  },
  title: {
    fontSize: 26,
    fontWeight: '900',
    color: colors.textDark,
    textAlign: 'center',
  },
  sub: {
    marginTop: 8,
    marginBottom: 14,
    fontSize: 15,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  field: { marginBottom: 16 },
  lbl: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textDark,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.chartGrid,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.textDark,
    backgroundColor: colors.card,
  },
  err: {
    color: colors.mutedCoral,
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
    fontWeight: '600',
  },
  info: {
    color: colors.primarySageGreen,
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
    fontWeight: '600',
    lineHeight: 20,
  },
  btn: {
    marginTop: 8,
    backgroundColor: colors.primarySageGreen,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.7 },
  btnTxt: { color: colors.card, fontWeight: '800', fontSize: 16 },
  linkWrap: { marginTop: 20, alignSelf: 'center', padding: 8 },
  link: {
    color: colors.primarySageGreen,
    fontWeight: '700',
    fontSize: 15,
    textDecorationLine: 'underline',
  },
  secondary: {
    marginTop: 16,
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  secondaryTxt: { color: colors.textMuted, fontWeight: '700', fontSize: 15 },
  googleBtn: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.chartGrid,
    backgroundColor: colors.card,
  },
  googleBtnTxt: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.textDark,
  },
  orRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
    gap: 10,
  },
  orLine: { flex: 1, height: 1, backgroundColor: colors.chartGrid },
  orText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'lowercase',
  },
});
