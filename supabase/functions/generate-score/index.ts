import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  addCalendarDaysIso,
  calculateFertileWindow,
  type ClinicalState,
  type DailyFertilityInput,
  type FertileWindowAlgorithmResult,
  findMostRecentCd1AnchorFromBleedingLogs,
  type ManualLogs,
  type ProfileCycleIntake,
  type TemperatureUnitForAlgo,
} from "../_shared/algorithms.ts";
import {
  calculateLocalBioScore,
  type TrackingGoal as LocalTrackingGoal,
} from "../_shared/localScoring.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const RECENT_MS = 48 * 60 * 60 * 1000;

type DataQuality = "optimal" | "missing_recent_biometrics";

type BiometricsBlock = {
  sleeping_temp_c?: number | null;
  hrv_ms?: number | null;
  rhr_bpm?: number | null;
  respiratory_rate?: number | null;
};

type ScoreBasis = "wearables" | "symptothermal";

type UnifiedScore = {
  fertility_score: number;
  ai_narrative: string;
  is_implantation_dip: boolean;
  is_triphasic: boolean;
  estimated_ovulation_date: string | null;
  is_estimate: boolean;
  clinical_engine_paused?: boolean;
  score_basis?: ScoreBasis;
  /** True when only menstrual/bleeding logs exist (no BBT, no wearable biometrics). */
  statistical_period_only?: boolean;
};

function num(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

function rowToNocturnalBiometrics(row: Record<string, unknown>): BiometricsBlock {
  return {
    sleeping_temp_c: num(row, [
      "sleeping_temp_c",
      "skin_temp_c",
      "sleeping_temperature_c",
      "temperature_c",
      "sleeping_temp",
    ]),
    hrv_ms: num(row, ["hrv_ms", "hrv", "heart_rate_variability"]),
    rhr_bpm: num(row, [
      "rhr_bpm",
      "rhr",
      "resting_heart_rate",
      "resting_hr_bpm",
    ]),
    respiratory_rate: num(row, [
      "respiratory_rate",
      "resp_rate",
      "breathing_rate",
    ]),
  };
}

function isComplete(b: BiometricsBlock): boolean {
  return (
    b.sleeping_temp_c != null &&
    b.hrv_ms != null &&
    b.rhr_bpm != null &&
    b.respiratory_rate != null
  );
}

function dataQualityFromRows(rows: Record<string, unknown>[]): DataQuality {
  if (rows.length === 0) return "missing_recent_biometrics";
  const latest = rows[0];
  const createdAt = latest.created_at;
  if (typeof createdAt !== "string") return "missing_recent_biometrics";
  const t = Date.parse(createdAt);
  if (Number.isNaN(t) || Date.now() - t > RECENT_MS) {
    return "missing_recent_biometrics";
  }
  return isComplete(rowToNocturnalBiometrics(latest)) ? "optimal" : "missing_recent_biometrics";
}

function averageMetrics(rows: Record<string, unknown>[]): BiometricsBlock {
  const list = rows.map(rowToNocturnalBiometrics);
  const avg = (key: keyof BiometricsBlock): number | null => {
    const vals = list.map((r) => r[key]).filter((v): v is number => v != null);
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  return {
    sleeping_temp_c: avg("sleeping_temp_c"),
    hrv_ms: avg("hrv_ms"),
    rhr_bpm: avg("rhr_bpm"),
    respiratory_rate: avg("respiratory_rate"),
  };
}

function buildScoreContext(rowsDesc: Record<string, unknown>[]): {
  data_quality: DataQuality;
  recent_nocturnal_biometrics: BiometricsBlock;
  historical_averages: BiometricsBlock | null;
} {
  const window = rowsDesc.slice(0, 60);
  if (window.length === 0) {
    return {
      data_quality: "missing_recent_biometrics",
      recent_nocturnal_biometrics: {
        sleeping_temp_c: null,
        hrv_ms: null,
        rhr_bpm: null,
        respiratory_rate: null,
      },
      historical_averages: null,
    };
  }
  const dq = dataQualityFromRows(window);
  const historical_averages = averageMetrics(window);
  return {
    data_quality: dq,
    recent_nocturnal_biometrics: rowToNocturnalBiometrics(window[0]),
    historical_averages,
  };
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toStoredInsightText(u: UnifiedScore): string {
  const payload: Record<string, unknown> = {
    narrative: u.ai_narrative,
    is_implantation_dip: u.is_implantation_dip,
    is_triphasic: u.is_triphasic,
    estimated_ovulation_date: u.estimated_ovulation_date,
  };
  if (u.clinical_engine_paused === true) {
    payload.clinical_engine_paused = true;
  }
  if (u.score_basis === "wearables" || u.score_basis === "symptothermal") {
    payload.score_basis = u.score_basis;
  }
  if (u.statistical_period_only === true) {
    payload.statistical_period_only = true;
  }
  return JSON.stringify(payload);
}

function rulesResultToUnified(r: FertileWindowAlgorithmResult): UnifiedScore {
  return {
    fertility_score: clampScore(r.fertility_score),
    ai_narrative: r.ai_narrative,
    is_implantation_dip: r.is_implantation_dip,
    is_triphasic: r.is_triphasic,
    estimated_ovulation_date: r.estimated_ovulation_date,
    is_estimate: r.is_estimate,
    clinical_engine_paused: r.clinical_engine_paused ?? false,
  };
}

function computeFreeTierUnified(
  dailySeries: DailyFertilityInput[],
  temperatureUnit: TemperatureUnitForAlgo,
  profileFallback: ProfileCycleIntake | null,
  clinicalState: ClinicalState,
  trackingGoal: LocalTrackingGoal,
): UnifiedScore {
  const algo = calculateFertileWindow(
    dailySeries,
    temperatureUnit,
    profileFallback,
    clinicalState,
  );
  const local = calculateLocalBioScore({
    dailySeriesAsc: dailySeries,
    temperatureUnit,
    thermal: algo,
    trackingGoal,
  });
  const rules = rulesResultToUnified(algo);
  return {
    ...rules,
    fertility_score: local.fertility_score,
    ai_narrative: `${local.scoreAttributionLine}\n\n${algo.ai_narrative}`,
    score_basis: local.score_basis,
  };
}

async function loadProfileRowForScore(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ profile: Record<string, unknown> | null; readError: string | null }> {
  const extendedSelect =
    "user_tier, temperature_unit, last_period_date, cycle_length_avg, onboarding_completed, clinical_state, tracking_goal, clinical_cycle_anchor_iso";
  const r1 = await admin.from("profiles").select(extendedSelect).eq("id", userId).maybeSingle();
  if (!r1.error && r1.data) {
    return { profile: r1.data as Record<string, unknown>, readError: null };
  }
  console.warn(
    "generate-score: extended profiles read failed, retrying minimal columns:",
    r1.error?.message,
  );
  const r2 = await admin
    .from("profiles")
    .select("temperature_unit, last_period_date, cycle_length_avg, onboarding_completed")
    .eq("id", userId)
    .maybeSingle();
  if (r2.error) {
    return { profile: null, readError: r2.error.message };
  }
  if (!r2.data) {
    return { profile: null, readError: r1.error?.message ?? "Profile row missing" };
  }
  const base = r2.data as Record<string, unknown>;
  return {
    profile: {
      ...base,
      user_tier: "free",
      clinical_state: null,
      tracking_goal: null,
      clinical_cycle_anchor_iso: null,
    },
    readError: null,
  };
}

async function loadDailySeries(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<DailyFertilityInput[]> {
  const { data: bio, error: bioErr } = await admin
    .from("biometrics")
    .select("date, sleeping_temp, rhr, hrv, created_at")
    .eq("user_id", userId)
    .order("date", { ascending: true })
    .limit(200);

  if (bioErr) {
    console.warn("generate-score: biometrics slice for dailySeries:", bioErr.message);
  }

  const { data: logs, error: logsErr } = await admin
    .from("manual_logs")
    .select("date, manual_bbt, exclude_temp, disturbances, cervical_fluid")
    .eq("user_id", userId)
    .order("date", { ascending: true })
    .limit(200);

  if (logsErr) {
    console.warn("generate-score: manual_logs slice for dailySeries:", logsErr.message);
  }

  const byDate = new Map<string, DailyFertilityInput>();

  for (const row of bio ?? []) {
    const r = row as Record<string, unknown>;
    const d = typeof r.date === "string" ? r.date : null;
    if (!d) continue;
    const cur = byDate.get(d) ?? { date: d, manual_bbt: null, sleeping_temp: null, rhr: null };
    if (r.sleeping_temp != null) cur.sleeping_temp = Number(r.sleeping_temp);
    if (r.rhr != null) cur.rhr = Number(r.rhr);
    if (r.hrv != null && Number.isFinite(Number(r.hrv))) cur.hrv = Number(r.hrv);
    byDate.set(d, cur);
  }

  for (const row of logs ?? []) {
    const r = row as Record<string, unknown>;
    const d = typeof r.date === "string" ? r.date : null;
    if (!d) continue;
    const cur = byDate.get(d) ?? { date: d, manual_bbt: null, sleeping_temp: null, rhr: null };
    if (r.manual_bbt != null) cur.manual_bbt = Number(r.manual_bbt);
    if (r.exclude_temp === true) cur.exclude_temp = true;
    const dist = r.disturbances;
    if (Array.isArray(dist) && dist.length > 0) {
      cur.disturbances = dist.map((x) => String(x));
    }
    const cf = r.cervical_fluid;
    if (cf != null && String(cf).trim() !== "") {
      cur.cervical_fluid = String(cf);
    }
    byDate.set(d, cur);
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function utcCalendarIsoToday(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

async function loadBleedingManualLogsForCd1(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<ManualLogs[]> {
  const minIso = addCalendarDaysIso(utcCalendarIsoToday(), -730);
  const { data, error } = await admin
    .from("manual_logs")
    .select("date, bleeding")
    .eq("user_id", userId)
    .gte("date", minIso)
    .order("date", { ascending: true });
  if (error || !data) return [];
  const out: ManualLogs[] = [];
  for (const r of data) {
    const row = r as Record<string, unknown>;
    out.push({
      date: String(row.date),
      bleeding: row.bleeding == null ? null : String(row.bleeding),
    });
  }
  return out;
}

function seriesHasAnyBbt(series: DailyFertilityInput[]): boolean {
  return series.some((d) => d.manual_bbt != null && Number.isFinite(Number(d.manual_bbt)));
}

async function manualLogsHaveBleeding(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<boolean> {
  const { count, error } = await admin
    .from("manual_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .not("bleeding", "is", null);
  if (error) {
    console.warn("generate-score: bleeding presence probe:", error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

function isStatisticalDetectivePeriod(
  biometricsRowCount: number,
  dailySeries: DailyFertilityInput[],
  hasBleeding: boolean,
): boolean {
  if (biometricsRowCount > 0) return false;
  if (seriesHasAnyBbt(dailySeries)) return false;
  return hasBleeding;
}

const STATISTICAL_DETECTIVE_GEMINI_BLOCK =
  `\n\nSTATISTICAL DETECTIVE MODE (data_density is statistical_detective):
Only menstrual/bleeding calendar data is present — wearable biometrics count is zero and no manual BBT values exist.
- fertility_score MUST be an integer from 0 through 70 inclusive (never above 70).
- Do NOT use words like "Confirmed" or "Detected" for ovulation or fertile timing. Prefer phrases such as "Based on your cycle history", "Estimated window", "Approximate", or "Projection."
- Close with a brief, gentle call to action: logging morning BBT and/or cervical fluid would help verify these estimates with higher precision (educational framing only, not medical advice).`;

const STATISTICAL_DETECTIVE_TAIL =
  "\n\n— Based on your cycle history so far. Logging morning BBT or cervical fluid would help verify this estimated window with higher precision.";

function applyStatisticalDetectiveAdjustments(
  u: UnifiedScore,
  active: boolean,
): UnifiedScore {
  if (!active) return u;
  const fertility_score = Math.min(70, clampScore(u.fertility_score));
  const ai_narrative = u.ai_narrative.includes("cycle history so far")
    ? u.ai_narrative
    : `${u.ai_narrative.trimEnd()}${STATISTICAL_DETECTIVE_TAIL}`;
  return {
    ...u,
    fertility_score,
    is_estimate: true,
    statistical_period_only: true,
    ai_narrative,
  };
}

function parseGeminiUnified(raw: string): UnifiedScore {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const fertility_score = parsed.fertility_score;
  const ai_narrative = parsed.ai_narrative;
  const is_implantation_dip = parsed.is_implantation_dip;
  const is_triphasic = parsed.is_triphasic;
  const est = parsed.estimated_ovulation_date;

  if (typeof fertility_score !== "number" || !Number.isFinite(fertility_score)) {
    throw new Error("Invalid fertility_score");
  }
  if (typeof ai_narrative !== "string") throw new Error("Invalid ai_narrative");
  if (typeof is_implantation_dip !== "boolean") {
    throw new Error("Invalid is_implantation_dip");
  }
  if (typeof is_triphasic !== "boolean") throw new Error("Invalid is_triphasic");
  if (typeof est !== "string") throw new Error("Invalid estimated_ovulation_date");

  const estimated_ovulation_date = est.trim() === "" ? null : est.trim();

  return {
    fertility_score: clampScore(fertility_score),
    ai_narrative,
    is_implantation_dip,
    is_triphasic,
    estimated_ovulation_date,
    is_estimate: false,
    clinical_engine_paused: false,
    score_basis: "symptothermal",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: "Server misconfiguration" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { profile, readError: profileReadError } = await loadProfileRowForScore(admin, user.id);
  if (profileReadError || profile == null) {
    console.error("profiles read:", profileReadError);
    return new Response(
      JSON.stringify({
        error: profileReadError ?? "Profile read failed",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const tierRaw = profile.user_tier;
  const userTier = tierRaw === "premium" ? "premium" : "free";

  const tempRaw = profile.temperature_unit;
  const temperatureUnit: TemperatureUnitForAlgo = tempRaw === "C" ? "C" : "F";

  const prof = profile;
  let profileFallback: ProfileCycleIntake | null = null;
  const clRaw = prof?.cycle_length_avg;
  const clNum = typeof clRaw === "number" ? clRaw : Number(clRaw);
  if (
    prof?.onboarding_completed === true &&
    typeof prof.last_period_date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(prof.last_period_date) &&
    Number.isFinite(clNum)
  ) {
    profileFallback = {
      last_period_date: prof.last_period_date,
      cycle_length_avg: clNum,
    };
  }

  if (profileFallback == null && Number.isFinite(clNum)) {
    const clRounded = Math.round(Number(clNum));
    if (clRounded >= 21 && clRounded <= 50) {
      const bleedLogs = await loadBleedingManualLogsForCd1(admin, user.id);
      const intakeLmp =
        typeof prof.last_period_date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(prof.last_period_date)
          ? prof.last_period_date
          : null;
      const cd1 = findMostRecentCd1AnchorFromBleedingLogs(bleedLogs, intakeLmp);
      if (cd1) {
        profileFallback = { last_period_date: cd1, cycle_length_avg: clRounded };
      }
    }
  }

  const rawGoal = prof?.tracking_goal;
  const trackingGoal: LocalTrackingGoal =
    rawGoal === "conceive" || rawGoal === "avoid" || rawGoal === "track_only"
      ? rawGoal
      : "track_only";

  const rawClinical = prof?.clinical_state;
  const clinicalState: ClinicalState =
    rawClinical === "pregnant" ||
    rawClinical === "postpartum" ||
    rawClinical === "loss" ||
    rawClinical === "cycling"
      ? rawClinical
      : "cycling";

  if (clinicalState !== "cycling") {
    const paused = calculateFertileWindow(
      [],
      temperatureUnit,
      profileFallback,
      clinicalState,
    );
    const unified = rulesResultToUnified(paused);

    const { error: insertPaused } = await supabase.from("cached_insight").insert({
      user_id: user.id,
      conception_score: unified.fertility_score,
      is_estimate: unified.is_estimate,
      insight_text: toStoredInsightText(unified),
    });
    if (insertPaused) {
      console.error("cached_insight insert (paused):", insertPaused);
      return new Response(
        JSON.stringify({
          error: "Failed to save insight",
          message: insertPaused.message,
          code: insertPaused.code,
          details: insertPaused.details,
          hint: insertPaused.hint,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const { error: profilePausedErr } = await supabase
      .from("profiles")
      .update({ has_new_biometrics: false })
      .eq("id", user.id);
    if (profilePausedErr) {
      console.warn(
        "profiles has_new_biometrics clear (ignored if column missing):",
        profilePausedErr.message,
      );
    }
    return new Response(JSON.stringify({ ok: true, ...unified }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const dailySeries = await loadDailySeries(admin, user.id);

  const { data: bioDesc, error: bioErr } = await admin
    .from("biometrics")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(60);

  if (bioErr) {
    console.warn("generate-score: biometrics read for context (continuing empty):", bioErr.message);
  }

  const rowsDesc = (bioErr ? [] : (bioDesc ?? [])) as Record<string, unknown>[];
  const scoreContext = buildScoreContext(rowsDesc);

  const hasBleeding = await manualLogsHaveBleeding(admin, user.id);
  const periodOnly = isStatisticalDetectivePeriod(rowsDesc.length, dailySeries, hasBleeding);

  let unified: UnifiedScore;

  const geminiKey = Deno.env.get("GEMINI_API_KEY")?.trim() ?? "";
  const useGemini = userTier === "premium" && geminiKey.length > 0;

  if (!useGemini) {
    if (userTier === "premium" && !geminiKey) {
      console.warn(
        "generate-score: GEMINI_API_KEY unset — using local/rules scoring for premium user",
      );
    }
    unified = computeFreeTierUnified(
      dailySeries,
      temperatureUnit,
      profileFallback,
      clinicalState,
      trackingGoal,
    );
  } else {
    try {
    const statGemSuffix = periodOnly ? STATISTICAL_DETECTIVE_GEMINI_BLOCK : "";
    const dataContextBlock =
      `Use the JSON context (daily_series, data_quality, recent and historical nocturnal summaries).
Each daily_series entry may include exclude_temp, disturbances, and cervical_fluid. When exclude_temp is true, the symptothermal engine ignores that day's temperatures for rules, but you MUST still read manual_bbt / sleeping_temp and disturbances to explain why (e.g. fever, alcohol) and how that affects interpretation.`;

    const scanTemperatureSeriesBlock =
      `You MUST explicitly scan the temperature series for:
1) Implantation dip: a one-day temperature decrease occurring 7–10 days after the estimated ovulation day (DPO window).
2) Triphasic pattern: a second distinct temperature rise in the late luteal phase after the initial post-ovulation elevation.`;

    const jsonFooter =
      `Respond ONLY with JSON matching the response schema. Be factual; if evidence is weak, set booleans false and use a conservative estimated_ovulation_date (ISO YYYY-MM-DD) or empty string if unknown.`;

    const SYSTEM_INSTRUCTION =
      (trackingGoal === "track_only"
        ? `You are a supportive menstrual-cycle awareness analyst (not a conception coach). ${dataContextBlock}

The user's tracking_goal is track_only ("Just understanding my cycle").

Hard bans on language:
- Do NOT write about conception chances, probability of pregnancy, "best time to try", TTC / baby-making framing, or optimizing intercourse timing.
- Do NOT describe cervical fluid as a cue to "try" or as peak fertility for conception; neutral cycle-structure language only.

What to do instead:
- Lead with cycle awareness: infer the most plausible current phase among Menstrual, Follicular, ovulatory window, or Luteal from BBT shape, HRV, resting HR, and recent disturbances — always hedge with uncertainty.
- Explain how current BBT / HRV / RHR trends correlate with typical hormonal phase patterns in plain educational language (never a medical diagnosis).
- Optionally mention energy and mood only as common population-level patterns tied to phases, not as statements about this user.
- When the series supports it, discuss period arrival heuristically (e.g. luteal-phase length, post-ovulation day count) without tying it to conception.
- fertility_score (0–100): interpret as clarity / coherence of the data for describing where she is in the cycle, not odds of conceiving.

${scanTemperatureSeriesBlock}
For track_only, describe implantation dip / triphasic only as neutral chart-structure curiosity, not pregnancy-hope messaging.

${jsonFooter}`
        : trackingGoal === "avoid"
          ? `You are an expert fertility analyst helping someone who is actively avoiding pregnancy. ${dataContextBlock}

The user's tracking_goal is avoid. Emphasize caution, fertile-window awareness, and thermal-shift confirmation when present. Do NOT encourage trying to conceive or "best time to conceive."

Cervical fluid: if cervical_fluid is "Eggwhite" or "Watery", describe elevated fertile-window attention and caution framing — not encouragement to conceive.

${scanTemperatureSeriesBlock}

${jsonFooter}`
          : `You are an expert fertility analyst helping someone who is trying to conceive. ${dataContextBlock}

The user's tracking_goal is conceive. Cervical fluid: if cervical_fluid is "Eggwhite" or "Watery", treat the user as being in a peak-fertile window for narrative purposes regardless of whether BBT has shifted yet. Explain that stretchy or watery fluid often appears as estrogen rises and can mark the opening of the fertile window before the thermal shift confirms ovulation.

${scanTemperatureSeriesBlock}

${jsonFooter}`) + statGemSuffix;

    const userMessage = JSON.stringify(
      {
        user_tier: "premium",
        tracking_goal: trackingGoal,
        data_density: periodOnly ? "statistical_detective" : "full",
        temperature_unit: temperatureUnit,
        data_quality: scoreContext.data_quality,
        recent_nocturnal_biometrics: scoreContext.recent_nocturnal_biometrics,
        historical_averages: scoreContext.historical_averages,
        daily_series: dailySeries,
      },
      null,
      2,
    );

    const geminiUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_INSTRUCTION }],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Cycle analysis (user ${user.id}):\n${userMessage}`,
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              fertility_score: { type: "integer" },
              ai_narrative: { type: "string" },
              is_implantation_dip: { type: "boolean" },
              is_triphasic: { type: "boolean" },
              estimated_ovulation_date: { type: "string" },
            },
            required: [
              "fertility_score",
              "ai_narrative",
              "is_implantation_dip",
              "is_triphasic",
              "estimated_ovulation_date",
            ],
          },
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error(`Gemini HTTP ${geminiRes.status}: ${errText.slice(0, 500)}`);
    }

    const geminiJson = (await geminiRes.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const rawText =
      geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    unified = parseGeminiUnified(rawText);
    unified.is_estimate = scoreContext.data_quality === "missing_recent_biometrics";
    } catch (e) {
      console.warn("generate-score: Gemini failed, falling back to local/rules:", e);
      unified = computeFreeTierUnified(
        dailySeries,
        temperatureUnit,
        profileFallback,
        clinicalState,
        trackingGoal,
      );
    }
  }

  unified = applyStatisticalDetectiveAdjustments(unified, periodOnly);

  const { error: insertError } = await supabase.from("cached_insight").insert({
    user_id: user.id,
    conception_score: unified.fertility_score,
    is_estimate: unified.is_estimate,
    insight_text: toStoredInsightText(unified),
  });

  if (insertError) {
    console.error("cached_insight insert:", insertError);
    return new Response(
      JSON.stringify({
        error: "Failed to save insight",
        message: insertError.message,
        code: insertError.code,
        details: insertError.details,
        hint: insertError.hint,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ has_new_biometrics: false })
    .eq("id", user.id);

  if (profileError) {
    console.warn(
      "profiles has_new_biometrics clear (ignored if column missing):",
      profileError.message,
    );
  }

  return new Response(JSON.stringify({ ok: true, ...unified }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("generate-score fatal:", e);
    return new Response(
      JSON.stringify({
        error: "generate_score_failed",
        message: msg,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
