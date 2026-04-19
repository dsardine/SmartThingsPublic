import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';

import { effectiveChartedTemp, type DailyFertilityInput } from '@/src/lib/algorithms';
import {
  addCalendarDays,
  formatCalendarDate,
  formatClinicalDateTime,
  isoDateString,
  parseIsoDate,
} from '@/src/lib/dateDisplay';
import {
  GHOST_MANUAL_KEY_PREFIX,
  mergeDailyInputsForAlgorithms,
  mergeManualLogsWithGhostStorage,
} from '@/src/lib/manualGhostMerge';
import { ghostStorage } from '@/src/lib/storage';
import { supabase } from '@/src/lib/supabase';
import { getPreferencesSnapshot } from '@/src/store';
import type { DateFormat } from '@/src/types/database';

const REPORT_TITLE = 'Sardine Empire LLC Clinical Report';

const PARTIAL_DISCLAIMER =
  'Partial Baseline: Charted temperatures and/or companion vitals are incomplete in this interval. ' +
  'Clinical interpretation should treat trends as provisional until more consecutive cycle days are logged.';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvEscape(cell: string): string {
  if (/[",\n\r]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

function formatIsoDateForExport(iso: string, dateFormat: DateFormat): string {
  return formatCalendarDate(parseIsoDate(iso), dateFormat, false);
}

function formatBbtTimeForExport(raw: unknown, dateFormat: DateFormat): string {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const parts = s.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1] ?? 0);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return s;
  const d = new Date(2000, 0, 1, h, m, 0, 0);
  return formatClinicalDateTime(d, dateFormat).split(' ').slice(1).join(' ');
}

function isPartialBaseline(
  bios: Record<string, unknown>[],
  mergedManual: Record<string, unknown>[],
  startIso: string,
  endIso: string,
): boolean {
  const series = mergeDailyInputsForAlgorithms(bios, mergedManual);
  const inRange = series.filter((r) => r.date >= startIso && r.date <= endIso);
  const withTemp = inRange.filter((r) => effectiveChartedTemp(r) != null);
  return withTemp.length < 6;
}

function buildRowsForRange(
  bios: Record<string, unknown>[],
  mergedManual: Record<string, unknown>[],
  startIso: string,
  endIso: string,
  dateFormat: DateFormat,
): { rows: string[][]; header: string[] } {
  const bioBy = new Map<string, Record<string, unknown>>();
  for (const b of bios) {
    const d = typeof b.date === 'string' ? b.date : null;
    if (d) bioBy.set(d, b);
  }
  const manBy = new Map<string, Record<string, unknown>>();
  for (const m of mergedManual) {
    const d = typeof m.date === 'string' ? m.date : null;
    if (d) manBy.set(d, m);
  }

  const header = [
    'Date',
    'Charted temp (BBT rule)',
    'Manual BBT',
    'BBT time',
    'Sleeping temp',
    'RHR',
    'HRV',
    'Respiratory rate',
    'Intercourse',
    'Test results',
    'Ghost overlay day',
  ];

  const rows: string[][] = [];
  let cursor = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  while (cursor <= end) {
    const iso = isoDateString(cursor);
    const b = bioBy.get(iso);
    const m = manBy.get(iso);
    const recordedBbt =
      m?.manual_bbt != null && String(m.manual_bbt).trim() !== '' ? Number(m.manual_bbt) : null;
    const mergedInput: DailyFertilityInput = {
      date: iso,
      manual_bbt: recordedBbt != null && Number.isFinite(recordedBbt) ? recordedBbt : null,
      sleeping_temp: b?.sleeping_temp != null ? Number(b.sleeping_temp) : null,
      rhr: b?.rhr != null ? Number(b.rhr) : null,
      exclude_temp: m?.exclude_temp === true,
    };

    const charted = effectiveChartedTemp(mergedInput);
    const ghostKey = `${GHOST_MANUAL_KEY_PREFIX}${iso}`;
    const ghostOverlay = ghostStorage.contains(ghostKey) ? 'yes' : 'no';

    const tests = m?.test_results;
    const testsStr = Array.isArray(tests)
      ? tests.join('; ')
      : tests != null
        ? String(tests)
        : '';

    rows.push([
      formatIsoDateForExport(iso, dateFormat),
      charted != null ? String(charted) : '',
      recordedBbt != null ? String(recordedBbt) : '',
      formatBbtTimeForExport(m?.bbt_time_taken, dateFormat),
      b?.sleeping_temp != null ? String(b.sleeping_temp) : '',
      b?.rhr != null ? String(b.rhr) : '',
      b?.hrv != null ? String(b.hrv) : '',
      b?.respiratory_rate != null ? String(b.respiratory_rate) : '',
      m?.intercourse != null ? String(m.intercourse) : '',
      testsStr,
      ghostOverlay,
    ]);
    cursor = addCalendarDays(cursor, 1);
  }

  return { rows, header };
}

async function loadExportWindow(
  userId: string,
  startIso: string,
  endIso: string,
): Promise<{ bios: Record<string, unknown>[]; mergedManual: Record<string, unknown>[] }> {
  const [bioRes, logRes] = await Promise.all([
    supabase
      .from('biometrics')
      .select('*')
      .eq('user_id', userId)
      .gte('date', startIso)
      .lte('date', endIso)
      .order('date', { ascending: true }),
    supabase
      .from('manual_logs')
      .select('*')
      .eq('user_id', userId)
      .gte('date', startIso)
      .lte('date', endIso)
      .order('date', { ascending: true }),
  ]);

  const bios = (bioRes.data ?? []) as Record<string, unknown>[];
  const logs = (logRes.data ?? []) as Record<string, unknown>[];
  const { mergedRows } = mergeManualLogsWithGhostStorage(logs, ghostStorage);
  return { bios, mergedManual: mergedRows };
}

async function buildCsvContents(
  startDate: Date,
  endDate: Date,
  dateFormat: DateFormat,
): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in to export CSV.');

  const startIso = isoDateString(startDate);
  const endIso = isoDateString(endDate);
  const { bios, mergedManual } = await loadExportWindow(user.id, startIso, endIso);
  const partial = isPartialBaseline(bios, mergedManual, startIso, endIso);
  const { rows, header } = buildRowsForRange(bios, mergedManual, startIso, endIso, dateFormat);

  const lines: string[] = [];
  lines.push(csvEscape(REPORT_TITLE));
  lines.push(
    `Generated,${csvEscape(formatClinicalDateTime(new Date(), dateFormat))},Date order,${csvEscape(dateFormat)}`,
  );
  if (partial) lines.push(csvEscape(PARTIAL_DISCLAIMER));
  lines.push(header.map(csvEscape).join(','));
  for (const r of rows) {
    lines.push(r.map((c) => csvEscape(c)).join(','));
  }
  return lines.join('\r\n');
}

/**
 * Renders a clinical PDF titled "Sardine Empire LLC Clinical Report".
 * Dates and clock times follow the signed-in user's `date_format` profile preference.
 * @returns Local `file://` URI from `expo-print` (share with `expo-sharing`).
 */
export async function generateClinicalPDF(startDate: Date, endDate: Date): Promise<string> {
  const dateFormat = getPreferencesSnapshot().dateFormat;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in to export a clinical report.');

  const startIso = isoDateString(startDate);
  const endIso = isoDateString(endDate);
  const { bios, mergedManual } = await loadExportWindow(user.id, startIso, endIso);
  const partial = isPartialBaseline(bios, mergedManual, startIso, endIso);
  const { rows, header } = buildRowsForRange(bios, mergedManual, startIso, endIso, dateFormat);
  const generatedAt = formatClinicalDateTime(new Date(), dateFormat);

  const headHtml = `<tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  const bodyHtml = rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('');

  const disclaimerBlock = partial
    ? `<p style="color:#8b4513;font-weight:700;">${escapeHtml(PARTIAL_DISCLAIMER)}</p>`
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(
    REPORT_TITLE,
  )}</title><style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 16px; color: #222; }
    h1 { font-size: 18px; margin-bottom: 4px; }
    .meta { font-size: 12px; color: #555; margin-bottom: 12px; }
    table { border-collapse: collapse; width: 100%; font-size: 11px; }
    th, td { border: 1px solid #ccc; padding: 6px; text-align: left; vertical-align: top; }
    th { background: #f0f4ef; }
  </style></head><body>
    <h1>${escapeHtml(REPORT_TITLE)}</h1>
    <div class="meta">Period: ${escapeHtml(formatIsoDateForExport(startIso, dateFormat))} — ${escapeHtml(
      formatIsoDateForExport(endIso, dateFormat),
    )}<br/>Generated: ${escapeHtml(generatedAt)} (device local time; date order per profile)</div>
    ${disclaimerBlock}
    <table><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table>
  </body></html>`;

  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}

/**
 * CSV export (same merged Supabase + Ghost Mode rules as the PDF). Uses the profile `date_format`
 * for every calendar date and for clock-style fields shown to clinicians.
 * Window: last 90 days through today unless you call `writeClinicalCsvFile` with a custom range.
 */
export async function generateCSV(): Promise<string> {
  const end = new Date();
  const start = addCalendarDays(end, -90);
  const dateFormat = getPreferencesSnapshot().dateFormat;
  return buildCsvContents(start, end, dateFormat);
}

/** Writes a CSV for the same default 90-day window as `generateCSV` to cache; returns `file://` URI. */
export async function writeClinicalCsvFile(): Promise<string> {
  const csv = await generateCSV();
  const base = FileSystem.cacheDirectory;
  if (!base) throw new Error('Cache directory unavailable; cannot stage CSV.');
  const path = `${base}sardine-clinical-export.csv`;
  await FileSystem.writeAsStringAsync(path, csv, { encoding: 'utf8' });
  return path;
}

/** Default export window: last 90 days through today (inclusive). */
export function defaultExportEndDate(): Date {
  return new Date();
}

export function defaultExportStartDate(): Date {
  return addCalendarDays(defaultExportEndDate(), -90);
}
