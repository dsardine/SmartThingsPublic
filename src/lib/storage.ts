import { createMMKV } from 'react-native-mmkv';

/** General app cache and Supabase Auth session persistence. */
export const appStorage = createMMKV({ id: 'app-storage' });

/** Local-only manual entry data for Ghost Mode — keep separate from `appStorage`. */
export const ghostStorage = createMMKV({ id: 'ghost-storage' });

/** Ghost Mode: rolling `cycle_length_avg` lives in `appStorage` only (never synced to Supabase). */
export const GHOST_DYNAMIC_CYCLE_LENGTH_AVG_KEY = 'ghost_dynamic_cycle_length_avg';
