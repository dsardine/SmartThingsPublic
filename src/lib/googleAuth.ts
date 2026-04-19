import * as QueryParams from 'expo-auth-session/build/QueryParams';
import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import { supabase } from '@/src/lib/supabase';

/**
 * Redirect URI for Google OAuth. Must be listed in Supabase Dashboard → Authentication →
 * URL Configuration → **Redirect URLs** (e.g. `sardine://auth/callback` or wildcard `sardine://**`).
 */
export function getGoogleOAuthRedirectUri(): string {
  return makeRedirectUri({
    scheme: 'sardine',
    path: 'auth/callback',
  });
}

export async function createSessionFromOAuthRedirect(url: string): Promise<void> {
  const { params, errorCode } = QueryParams.getQueryParams(url);
  if (errorCode) {
    throw new Error(errorCode);
  }
  if (params.error) {
    throw new Error(params.error_description ?? params.error);
  }

  if (params.code) {
    const { error } = await supabase.auth.exchangeCodeForSession(params.code);
    if (error) throw error;
    return;
  }

  const access_token = params.access_token;
  const refresh_token = params.refresh_token ?? '';
  if (!access_token) {
    throw new Error('Missing OAuth tokens in redirect URL.');
  }

  const { error } = await supabase.auth.setSession({
    access_token,
    refresh_token,
  });
  if (error) throw error;
}

export async function signInWithGoogle(): Promise<{ error: Error | null }> {
  const redirectTo = getGoogleOAuthRedirectUri();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      skipBrowserRedirect: true,
    },
  });

  if (error) {
    return { error: new Error(error.message) };
  }
  if (!data?.url) {
    return { error: new Error('No OAuth URL returned from Supabase.') };
  }

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);

  if (result.type !== 'success' || !result.url) {
    if (result.type === 'cancel' || result.type === 'dismiss') {
      return { error: new Error('Sign-in canceled.') };
    }
    return { error: new Error('Google sign-in was not completed.') };
  }

  try {
    await createSessionFromOAuthRedirect(result.url);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  }
}
