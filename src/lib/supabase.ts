import { createClient } from '@supabase/supabase-js';

import { appStorage } from '@/src/lib/storage';
import type { Database } from '@/src/types/database';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

/**
 * Auth session persistence on `appStorage` (MMKV). Supabase’s default RN path uses
 * AsyncStorage; this client uses MMKV only via the custom adapter below.
 */
const supabaseMmkvAuthStorage = {
  getItem: async (key: string) => appStorage.getString(key) ?? null,
  setItem: async (key: string, value: string) => {
    appStorage.set(key, value);
  },
  removeItem: async (key: string) => {
    appStorage.remove(key);
  },
};

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: supabaseMmkvAuthStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
