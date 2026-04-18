/**
 * Global TaskManager definition — import this module once from `app/_layout.tsx`
 * so the task is registered before any background fetch runs.
 */
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';

import { supabase } from '@/src/lib/supabase';

export const BACKGROUND_SCORE_TASK = 'sardine-background-score';

TaskManager.defineTask(BACKGROUND_SCORE_TASK, async () => {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('has_new_biometrics')
      .eq('id', session.user.id)
      .maybeSingle();

    if (!profile?.has_new_biometrics) {
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    const url = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/generate-score`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    if (!res.ok) {
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundScoreFetch(): Promise<void> {
  const registered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SCORE_TASK);
  if (registered) return;
  await BackgroundFetch.registerTaskAsync(BACKGROUND_SCORE_TASK, {
    minimumInterval: 60 * 60 * 12,
    stopOnTerminate: false,
    startOnBoot: true,
  });
}
