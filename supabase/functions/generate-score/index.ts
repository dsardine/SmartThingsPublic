import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  calculateFertileWindow,
  type DailyFertilityInput,
  type FertileWindowAlgorithmResult,
  type TemperatureUnitForAlgo,
} from "../_shared/algorithms.ts";

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

type UnifiedScore = {
  fertility_score: number;
  ai_narrative: string;
  is_implantation_dip: boolean;
  is_triphasic: boolean;
  estimated_ovulation_date: string | null;
  is_estimate: boolean;
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
  return JSON.stringify({
    narrative: u.ai_narrative,
    is_implantation_dip: u.is_implantation_dip,
    is_triphasic: u.is_triphasic,
    estimated_ovulation_date: u.estimated_ovulation_date,
  });
}

function rulesResultToUnified(r: FertileWindowAlgorithmResult): UnifiedScore {
  return {
    fertility_score: clampScore(r.fertility_score),
    ai_narrative: r.ai_narrative,
    is_implantation_dip: r.is_implantation_dip,
    is_triphasic: r.is_triphasic,
    estimated_ovulation_date: r.estimated_ovulation_date,
    is_estimate: r.is_estimate,
  };
}

async function loadDailySeries(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<DailyFertilityInput[]> {
  const { data: bio } = await admin
    .from("biometrics")
    .select("date, sleeping_temp, rhr, created_at")
    .eq("user_id", userId)
    .order("date", { ascending: true })
    .limit(200);

  const { data: logs } = await admin
    .from("manual_logs")
    .select("date, manual_bbt")
    .eq("user_id", userId)
    .order("date", { ascending: true })
    .limit(200);

  const byDate = new Map<string, DailyFertilityInput>();

  for (const row of bio ?? []) {
    const r = row as Record<string, unknown>;
    const d = typeof r.date === "string" ? r.date : null;
    if (!d) continue;
    const cur = byDate.get(d) ?? { date: d, manual_bbt: null, sleeping_temp: null, rhr: null };
    if (r.sleeping_temp != null) cur.sleeping_temp = Number(r.sleeping_temp);
    if (r.rhr != null) cur.rhr = Number(r.rhr);
    byDate.set(d, cur);
  }

  for (const row of logs ?? []) {
    const r = row as Record<string, unknown>;
    const d = typeof r.date === "string" ? r.date : null;
    if (!d) continue;
    const cur = byDate.get(d) ?? { date: d, manual_bbt: null, sleeping_temp: null, rhr: null };
    if (r.manual_bbt != null) cur.manual_bbt = Number(r.manual_bbt);
    byDate.set(d, cur);
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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

  const { data: profile, error: profileReadError } = await admin
    .from("profiles")
    .select("user_tier, temperature_unit")
    .eq("id", user.id)
    .maybeSingle();

  if (profileReadError) {
    console.error("profiles read:", profileReadError);
    return new Response(JSON.stringify({ error: "Profile read failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const tierRaw = (profile as Record<string, unknown> | null)?.user_tier;
  const userTier = tierRaw === "premium" ? "premium" : "free";

  const tempRaw = (profile as Record<string, unknown> | null)?.temperature_unit;
  const temperatureUnit: TemperatureUnitForAlgo = tempRaw === "C" ? "C" : "F";

  const dailySeries = await loadDailySeries(admin, user.id);

  const { data: bioDesc, error: bioErr } = await admin
    .from("biometrics")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(60);

  if (bioErr) {
    console.error("biometrics read:", bioErr);
    return new Response(JSON.stringify({ error: "Biometrics read failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const rowsDesc = (bioDesc ?? []) as Record<string, unknown>[];
  const scoreContext = buildScoreContext(rowsDesc);

  let unified: UnifiedScore;

  if (userTier === "free") {
    const algo = calculateFertileWindow(dailySeries, temperatureUnit);
    unified = rulesResultToUnified(algo);
  } else {
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      return new Response(
        JSON.stringify({ error: "Server misconfiguration" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const SYSTEM_INSTRUCTION =
      `You are an expert fertility analyst. Use the JSON context (daily_series, data_quality, recent and historical nocturnal summaries).
You MUST explicitly scan the temperature series for:
1) Implantation dip: a one-day temperature decrease occurring 7–10 days after the estimated ovulation day (DPO window).
2) Triphasic pattern: a second distinct temperature rise in the late luteal phase after the initial post-ovulation elevation.

Respond ONLY with JSON matching the response schema. Be factual; if evidence is weak, set booleans false and use a conservative estimated_ovulation_date (ISO YYYY-MM-DD) or empty string if unknown.`;

    const userMessage = JSON.stringify(
      {
        user_tier: "premium",
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
                text: `Fertility analysis (user ${user.id}):\n${userMessage}`,
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
      console.error("Gemini error:", geminiRes.status, errText);
      return new Response(
        JSON.stringify({ error: "Upstream model error" }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const geminiJson = (await geminiRes.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const rawText =
      geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    try {
      unified = parseGeminiUnified(rawText);
      unified.is_estimate = scoreContext.data_quality === "missing_recent_biometrics";
    } catch (e) {
      console.error("Parse model output:", e, rawText);
      return new Response(JSON.stringify({ error: "Invalid model output" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  const { error: insertError } = await admin.from("cached_insight").insert({
    user_id: user.id,
    conception_score: unified.fertility_score,
    is_estimate: unified.is_estimate,
    insight_text: toStoredInsightText(unified),
  });

  if (insertError) {
    console.error("cached_insight insert:", insertError);
    return new Response(JSON.stringify({ error: "Failed to save insight" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { error: profileError } = await admin
    .from("profiles")
    .update({ has_new_biometrics: false })
    .eq("id", user.id);

  if (profileError) {
    console.error("profiles update:", profileError);
    return new Response(
      JSON.stringify({ error: "Failed to update profile flag" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  return new Response(JSON.stringify({ ok: true, ...unified }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
