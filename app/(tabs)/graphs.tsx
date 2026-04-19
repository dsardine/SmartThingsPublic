import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFocusEffect } from '@react-navigation/native';
import Svg, { Line, Polyline, Text as SvgText } from 'react-native-svg';

import {
  type DailyFertilityInput,
  effectiveChartedTemp,
  getAlgorithmicCoverlineY,
} from '@/src/lib/algorithms';
import { parseInsightText } from '@/src/lib/cachedInsight';
import { addCalendarDays, isoDateString } from '@/src/lib/dateDisplay';
import {
  mergeDailyInputsForAlgorithms,
  mergeManualLogsWithGhostStorage,
} from '@/src/lib/manualGhostMerge';
import { ghostStorage } from '@/src/lib/storage';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import { colors } from '@/src/styles/theme';

const DAY_W = 52;
const CHART_H = 220;
const PAD_T = 20;
const PAD_B = 32;

type Metric = 'temp' | 'hrv' | 'rhr' | 'resp';

type DayColumn = {
  date: string;
  temp: number | null;
  hrv: number | null;
  rhr: number | null;
  resp: number | null;
  intercourse: boolean;
  hasTests: boolean;
  sleepRaw: number | null;
  manBbt: number | null;
  /** Ghost Mode key exists for this calendar day (manual overlay from MMKV). */
  hasGhostManualEntry: boolean;
};

function buildLast14Days(columns: Map<string, DayColumn>): DayColumn[] {
  const out: DayColumn[] = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = addCalendarDays(today, -i);
    const iso = isoDateString(d);
    out.push(
      columns.get(iso) ?? {
        date: iso,
        temp: null,
        hrv: null,
        rhr: null,
        resp: null,
        intercourse: false,
        hasTests: false,
        sleepRaw: null,
        manBbt: null,
        hasGhostManualEntry: false,
      },
    );
  }
  return out;
}

function valueForMetric(col: DayColumn, m: Metric): number | null {
  switch (m) {
    case 'temp':
      return col.temp;
    case 'hrv':
      return col.hrv;
    case 'rhr':
      return col.rhr;
    case 'resp':
      return col.resp;
    default:
      return null;
  }
}

export default function GraphsScreen() {
  const scrollRef = useRef<ScrollView>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState<DayColumn[]>([]);
  const [mergedAsc, setMergedAsc] = useState<DailyFertilityInput[]>([]);
  const [ovulationIso, setOvulationIso] = useState<string | null>(null);
  const [markerLabel] = useState('Ovulation estimated');
  const [active, setActive] = useState<Metric>('temp');
  const temperatureUnit = useAppStore((s) => s.preferences.temperatureUnit);
  const clinicalState = useAppStore((s) => s.clinicalState);

  const load = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setDays([]);
      setMergedAsc([]);
      setLoading(false);
      return;
    }

    const today = new Date();
    const start = addCalendarDays(today, -45);
    const startIso = isoDateString(start);

    const [bioRes, logRes, insightRes] = await Promise.all([
      supabase
        .from('biometrics')
        .select('date, sleeping_temp, rhr, hrv, respiratory_rate')
        .eq('user_id', user.id)
        .gte('date', startIso)
        .order('date', { ascending: true }),
      supabase
        .from('manual_logs')
        .select('date, manual_bbt, exclude_temp, disturbances, intercourse, test_results')
        .eq('user_id', user.id)
        .gte('date', startIso)
        .order('date', { ascending: true }),
      supabase
        .from('cached_insight')
        .select('insight_text')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const bios = (bioRes.data ?? []) as Record<string, unknown>[];
    const logs = (logRes.data ?? []) as Record<string, unknown>[];
    const { mergedRows: mergedLogs, ghostDates } = mergeManualLogsWithGhostStorage(logs, ghostStorage);

    const colMap = new Map<string, DayColumn>();
    for (const row of bios) {
      const d = typeof row.date === 'string' ? row.date : null;
      if (!d) continue;
      const cur = colMap.get(d) ?? {
        date: d,
        temp: null,
        hrv: null,
        rhr: null,
        resp: null,
        intercourse: false,
        hasTests: false,
        sleepRaw: null,
        manBbt: null,
        hasGhostManualEntry: false,
      };
      cur.sleepRaw = row.sleeping_temp != null ? Number(row.sleeping_temp) : null;
      const mergedRow: DailyFertilityInput = {
        date: d,
        manual_bbt: cur.manBbt,
        sleeping_temp: cur.sleepRaw,
        rhr: row.rhr != null ? Number(row.rhr) : null,
        exclude_temp: undefined,
      };
      const t = effectiveChartedTemp(mergedRow);
      cur.temp = t;
      if (row.hrv != null) cur.hrv = Number(row.hrv);
      if (row.rhr != null) cur.rhr = Number(row.rhr);
      if (row.respiratory_rate != null) cur.resp = Number(row.respiratory_rate);
      colMap.set(d, cur);
    }
    for (const row of mergedLogs) {
      const d = typeof row.date === 'string' ? row.date : null;
      if (!d) continue;
      const cur = colMap.get(d) ?? {
        date: d,
        temp: null,
        hrv: null,
        rhr: null,
        resp: null,
        intercourse: false,
        hasTests: false,
        sleepRaw: null,
        manBbt: null,
        hasGhostManualEntry: false,
      };
      const rec =
        row.manual_bbt != null && String(row.manual_bbt).trim() !== ''
          ? Number(row.manual_bbt)
          : null;
      if (rec != null && Number.isFinite(rec)) cur.manBbt = rec;
      const dist = row.disturbances;
      const disturbances =
        Array.isArray(dist) && dist.length > 0 ? dist.map((x) => String(x)) : null;
      cur.temp = effectiveChartedTemp({
        date: d,
        manual_bbt: rec,
        sleeping_temp: cur.sleepRaw,
        rhr: cur.rhr,
        exclude_temp: row.exclude_temp === true,
        disturbances,
      });
      if (row.intercourse != null) cur.intercourse = true;
      const tr = row.test_results;
      if (Array.isArray(tr) && tr.length > 0) cur.hasTests = true;
      cur.hasGhostManualEntry = ghostDates.has(d);
      colMap.set(d, cur);
    }

    setDays(buildLast14Days(colMap));
    setMergedAsc(mergeDailyInputsForAlgorithms(bios, mergedLogs));

    if (insightRes.data?.insight_text) {
      const p = parseInsightText(insightRes.data.insight_text);
      setOvulationIso(p.estimatedOvulationDate);
    } else {
      setOvulationIso(null);
    }

    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const cover = useMemo(() => {
    if (active !== 'temp') return null;
    return getAlgorithmicCoverlineY(mergedAsc, temperatureUnit, clinicalState);
  }, [active, mergedAsc, temperatureUnit, clinicalState]);

  const { polyPoints, coverYpx, minV, maxV, ovulationIndex } = useMemo(() => {
    const vals = days.map((d) => valueForMetric(d, active)).filter((v): v is number => v != null);
    let min = vals.length ? Math.min(...vals) : 0;
    let max = vals.length ? Math.max(...vals) : 1;
    if (cover != null && active === 'temp') {
      min = Math.min(min, cover.coverlineY);
      max = Math.max(max, cover.coverlineY);
    }
    if (max === min) {
      max = min + 1;
    }
    const span = max - min;
    const innerH = CHART_H - PAD_T - PAD_B;
    const toY = (v: number) => PAD_T + innerH * (1 - (v - min) / span);

    const pts: string[] = [];
    days.forEach((d, i) => {
      const v = valueForMetric(d, active);
      if (v == null) return;
      const x = i * DAY_W + DAY_W / 2;
      const y = toY(v);
      pts.push(`${x},${y}`);
    });

    let cy: number | null = null;
    if (cover != null && active === 'temp') {
      cy = toY(cover.coverlineY);
    }

    const ovi = ovulationIso ? days.findIndex((d) => d.date === ovulationIso) : -1;

    return {
      polyPoints: pts.join(' '),
      coverYpx: cy,
      minV: min,
      maxV: max,
      ovulationIndex: ovi,
    };
  }, [days, active, cover, ovulationIso]);

  const unitSuffix = active === 'temp' ? (temperatureUnit === 'F' ? '°F' : '°C') : '';

  const yTicks = useMemo(() => {
    const innerH = CHART_H - PAD_T - PAD_B;
    const ticks: { y: number; label: string }[] = [];
    for (let t = 0; t <= 3; t++) {
      const frac = t / 3;
      const v = minV + (maxV - minV) * (1 - frac);
      const y = PAD_T + innerH * frac;
      const label =
        active === 'temp'
          ? `${v.toFixed(1)}${unitSuffix}`
          : active === 'hrv'
            ? `${Math.round(v)}`
            : `${Math.round(v)}`;
      ticks.push({ y, label });
    }
    return ticks;
  }, [minV, maxV, active, unitSuffix]);

  const chartWidth = days.length * DAY_W;

  return (
    <View style={styles.root}>
      <Text style={styles.title}>14-day vitals</Text>
      <Text style={styles.sub}>
        Toggles switch the trace. Coverline is algorithm-only — no dragging, no drama.
      </Text>

      <View style={styles.toggles}>
        {(
          [
            ['temp', 'Temp'],
            ['hrv', 'HRV'],
            ['rhr', 'RHR'],
            ['resp', 'Resp'],
          ] as const
        ).map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => setActive(key)}
            style={[styles.toggle, active === key && styles.toggleOn]}>
            <Text style={[styles.toggleText, active === key && styles.toggleTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={colors.primarySageGreen} />
      ) : (
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          contentContainerStyle={{ paddingVertical: 8 }}>
          <View style={{ width: chartWidth + 40 }}>
            <Svg width={chartWidth} height={CHART_H}>
              {yTicks.map((t, i) => (
                <SvgText
                  key={i}
                  x={4}
                  y={t.y + 4}
                  fontSize={10}
                  fill={colors.textMuted}>
                  {t.label}
                </SvgText>
              ))}
              {coverYpx != null && active === 'temp' ? (
                <Line
                  x1={0}
                  x2={chartWidth}
                  y1={coverYpx}
                  y2={coverYpx}
                  stroke={colors.primarySageGreen}
                  strokeDasharray="6 6"
                  strokeWidth={2}
                />
              ) : null}
              {ovulationIndex >= 0 ? (
                <Line
                  x1={ovulationIndex * DAY_W + DAY_W / 2}
                  x2={ovulationIndex * DAY_W + DAY_W / 2}
                  y1={PAD_T}
                  y2={CHART_H - PAD_B}
                  stroke={colors.mutedCoral}
                  strokeWidth={2}
                />
              ) : null}
              {polyPoints.includes(' ') ? (
                <Polyline
                  points={polyPoints}
                  fill="none"
                  stroke={colors.softLavender}
                  strokeWidth={3}
                />
              ) : null}
              {ovulationIndex >= 0 ? (
                <SvgText
                  x={ovulationIndex * DAY_W + DAY_W / 2 - 36}
                  y={PAD_T - 4}
                  fontSize={10}
                  fill={colors.mutedCoral}>
                  {markerLabel}
                </SvgText>
              ) : null}
            </Svg>

            <View style={[styles.iconRow, { width: chartWidth }]}>
              {days.map((d) => (
                <View key={d.date} style={{ width: DAY_W, alignItems: 'center' }}>
                  {d.intercourse ? (
                    <FontAwesome name="heart" size={12} color={colors.mutedCoral} />
                  ) : (
                    <View style={{ height: 14 }} />
                  )}
                  {d.hasTests ? (
                    <FontAwesome
                      name="flask"
                      size={12}
                      color={colors.primarySageGreen}
                      style={{ marginTop: 2 }}
                    />
                  ) : null}
                  {d.hasGhostManualEntry ? (
                    <FontAwesome
                      name="user-secret"
                      size={11}
                      color={colors.softLavender}
                      style={{ marginTop: 2 }}
                      accessibilityLabel="Ghost Mode manual entry"
                    />
                  ) : null}
                </View>
              ))}
            </View>

            <View style={[styles.dayLabels, { width: chartWidth }]}>
              {days.map((d) => (
                <Text key={d.date} style={styles.dayLabel} numberOfLines={1}>
                  {d.date.slice(5)}
                </Text>
              ))}
            </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    paddingTop: 12,
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.textDark,
  },
  sub: {
    marginTop: 6,
    fontSize: 14,
    color: colors.textMuted,
    marginBottom: 12,
  },
  toggles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  toggle: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.chartGrid,
  },
  toggleOn: {
    backgroundColor: colors.primarySageGreen,
    borderColor: colors.primarySageGreen,
  },
  toggleText: {
    fontWeight: '700',
    color: colors.textDark,
    fontSize: 13,
  },
  toggleTextOn: {
    color: colors.card,
  },
  iconRow: {
    flexDirection: 'row',
    marginTop: 4,
  },
  dayLabels: {
    flexDirection: 'row',
    marginTop: 6,
  },
  dayLabel: {
    width: DAY_W,
    textAlign: 'center',
    fontSize: 10,
    color: colors.textMuted,
  },
});
