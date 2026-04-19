/**
 * Sardine public schema — mirrors planned Supabase tables (Sprint 2).
 * DB defaults: profiles `temperature_unit` 'F', `first_day_of_week` 'Sunday', `date_format` 'MM/DD/YYYY'.
 *
 * Row / Insert / Update types intersect `Record<string, unknown>` so they satisfy PostgREST `GenericTable`
 * and `createClient<Database>()` can infer `.select()` / `.maybeSingle()` results.
 */

export type UserTier = 'free' | 'premium';

export type TemperatureUnit = 'F' | 'C';

export type FirstDayOfWeek = 'Sunday' | 'Monday';

export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY';

/** How manual BBT "time taken" is shown; storage remains `HH:MM` 24-hour. */
export type BbtTimeFormat = '12h' | '24h';

export type ManualLogBleeding = 'Spotting' | 'Light' | 'Medium' | 'Heavy';

export type ManualLogIntercourse = 'Protected' | 'Unprotected' | 'Insemination';

export type ManualLogCervicalFluid = 'Dry' | 'Sticky' | 'Creamy' | 'Eggwhite';

export type ManualLogCervicalPosition = 'High' | 'Medium' | 'Low';

export type ManualLogCervicalFirmness = 'Soft' | 'Firm';

/** Allowed `disturbances` multi-select values (stored as text[]). */
export type ManualLogDisturbance = 'Fever' | 'Alcohol' | 'Poor Sleep' | 'Travel';

export type ProfilesRow = {
  id: string;
  user_tier: UserTier;
  allow_partner_manual_entry: boolean;
  /** Default in DB: `'F'`. */
  temperature_unit: TemperatureUnit;
  /** Default in DB: `'Sunday'`. */
  first_day_of_week: FirstDayOfWeek;
  /** Default in DB: `'MM/DD/YYYY'`. */
  date_format: DateFormat;
  /** Default in DB: `'12h'`. */
  bbt_time_format: BbtTimeFormat;
  /** Drives cached vs fresh score generation (existing pipeline). */
  has_new_biometrics: boolean | null;
  /** First day of last period (LMP) from Day-zero intake; ISO `YYYY-MM-DD`. */
  last_period_date: string | null;
  /** Typical cycle length in days; DB default `28`, constrained 21–50. */
  cycle_length_avg: number;
  /** When `false`, app routes to onboarding before tabs. */
  onboarding_completed: boolean;
} & Record<string, unknown>;

export type ProfilesInsert = {
  id: string;
  user_tier?: UserTier;
  allow_partner_manual_entry?: boolean;
  temperature_unit?: TemperatureUnit;
  first_day_of_week?: FirstDayOfWeek;
  date_format?: DateFormat;
  bbt_time_format?: BbtTimeFormat;
  has_new_biometrics?: boolean | null;
  last_period_date?: string | null;
  cycle_length_avg?: number;
  onboarding_completed?: boolean;
} & Record<string, unknown>;

export type ProfilesUpdate = Partial<Omit<ProfilesRow, 'id'>> & Record<string, unknown>;

export type BiometricsRow = {
  id: string;
  user_id: string;
  /** ISO `date` string (YYYY-MM-DD). */
  date: string;
  sleeping_temp: number | null;
  rhr: number | null;
  hrv: number | null;
  respiratory_rate: number | null;
  /** Present when the table includes a server `created_at` (ordering / sync). */
  created_at?: string | null;
} & Record<string, unknown>;

export type BiometricsInsert = Omit<BiometricsRow, 'id'> & { id?: string };

export type BiometricsUpdate = Partial<Omit<BiometricsRow, 'id' | 'user_id'>> & Record<string, unknown>;

export type ManualLogsRow = {
  id: string;
  user_id: string;
  /** ISO `date` string (YYYY-MM-DD). */
  date: string;
  manual_bbt: number | null;
  /** PostgreSQL `time` as `HH:MM:SS` (or with offset per server). */
  bbt_time_taken: string | null;
  exclude_temp: boolean | null;
  bleeding: ManualLogBleeding | null;
  intercourse: ManualLogIntercourse | null;
  cervical_fluid: ManualLogCervicalFluid | null;
  cervical_position: ManualLogCervicalPosition | null;
  cervical_firmness: ManualLogCervicalFirmness | null;
  disturbances: ManualLogDisturbance[] | null;
  symptoms: string[] | null;
  test_results: string[] | null;
  /** When true, calendar shows bleeding stripe from last logged bleeding day through this date. */
  period_end: boolean;
} & Record<string, unknown>;

export type ManualLogsInsert = Omit<ManualLogsRow, 'id'> & { id?: string };

export type ManualLogsUpdate = Partial<Omit<ManualLogsRow, 'id' | 'user_id'>> & Record<string, unknown>;

/** Cached LLM / score snapshot (existing `generate-score` + dashboard flow). */
export type CachedInsightRow = {
  id: string;
  user_id: string;
  conception_score: number;
  is_estimate: boolean;
  insight_text: string;
  created_at: string;
} & Record<string, unknown>;

export type CachedInsightInsert = Omit<CachedInsightRow, 'id'> & { id?: string };

export type CachedInsightUpdate = Partial<Omit<CachedInsightRow, 'id' | 'user_id'>> &
  Record<string, unknown>;

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '12';
  };
  public: {
    Tables: {
      profiles: {
        Row: ProfilesRow;
        Insert: ProfilesInsert;
        Update: ProfilesUpdate;
        Relationships: [];
      };
      biometrics: {
        Row: BiometricsRow;
        Insert: BiometricsInsert;
        Update: BiometricsUpdate;
        Relationships: [];
      };
      manual_logs: {
        Row: ManualLogsRow;
        Insert: ManualLogsInsert;
        Update: ManualLogsUpdate;
        Relationships: [];
      };
      cached_insight: {
        Row: CachedInsightRow;
        Insert: CachedInsightInsert;
        Update: CachedInsightUpdate;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
  };
};
