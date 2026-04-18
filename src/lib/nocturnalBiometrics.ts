/** Map wearable / DB rows to the Edge Function payload (flexible column names). */

/** ~two full cycles of nightly rows for a medically sound historical baseline. */
export const MAX_BASELINE_ROWS = 60;

const RECENT_MS = 48 * 60 * 60 * 1000;

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

export type NocturnalBiometrics = {
  sleeping_temp_c: number | null;
  hrv_ms: number | null;
  rhr_bpm: number | null;
  respiratory_rate: number | null;
};

export function rowToNocturnalBiometrics(
  row: Record<string, unknown>,
): NocturnalBiometrics {
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

function isComplete(b: NocturnalBiometrics): boolean {
  return (
    b.sleeping_temp_c != null &&
    b.hrv_ms != null &&
    b.rhr_bpm != null &&
    b.respiratory_rate != null
  );
}

function averageMetrics(rows: Record<string, unknown>[]): NocturnalBiometrics {
  const list = rows.map(rowToNocturnalBiometrics);
  const avg = (key: keyof NocturnalBiometrics): number | null => {
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

export function buildGenerateScorePayload(rows: Record<string, unknown>[]): {
  data_quality: "optimal" | "missing_recent_biometrics";
  recent_nocturnal_biometrics: NocturnalBiometrics;
  historical_averages: NocturnalBiometrics | null;
} {
  const window = rows.slice(0, MAX_BASELINE_ROWS);

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

  const latest = window[0];
  const createdAt = latest.created_at;
  let recentOk = false;
  if (typeof createdAt === "string") {
    const t = Date.parse(createdAt);
    if (!Number.isNaN(t) && Date.now() - t <= RECENT_MS) {
      const b = rowToNocturnalBiometrics(latest);
      recentOk = isComplete(b);
    }
  }

  const historical_averages = averageMetrics(window);

  if (recentOk) {
    return {
      data_quality: "optimal",
      recent_nocturnal_biometrics: rowToNocturnalBiometrics(latest),
      historical_averages,
    };
  }

  return {
    data_quality: "missing_recent_biometrics",
    recent_nocturnal_biometrics: rowToNocturnalBiometrics(latest),
    historical_averages,
  };
}
