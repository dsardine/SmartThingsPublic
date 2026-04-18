import { createMMKV } from 'react-native-mmkv';

/** General app cache and Supabase Auth session persistence. */
export const appStorage = createMMKV({ id: 'app-storage' });

/** Local-only manual entry data for Ghost Mode — keep separate from `appStorage`. */
export const ghostStorage = createMMKV({ id: 'ghost-storage' });
