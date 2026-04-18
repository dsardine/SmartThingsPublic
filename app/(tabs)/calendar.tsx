import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';

import { parseInsightText } from '@/src/lib/cachedInsight';
import {
  addCalendarDays,
  formatCalendarDate,
  isoDateString,
  parseIsoDate,
} from '@/src/lib/dateDisplay';
import { GHOST_MANUAL_KEY_PREFIX } from '@/src/lib/manualGhostMerge';
import { ghostStorage } from '@/src/lib/storage';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import { colors } from '@/src/styles/theme';
import type {
  ManualLogBleeding,
  ManualLogCervicalFirmness,
  ManualLogCervicalFluid,
  ManualLogCervicalPosition,
  ManualLogDisturbance,
  ManualLogIntercourse,
} from '@/src/types/database';

const BLEEDING_OPTS: ManualLogBleeding[] = ['Spotting', 'Light', 'Medium', 'Heavy'];
const INTERCOURSE_OPTS: ManualLogIntercourse[] = ['Protected', 'Unprotected', 'Insemination'];
const FLUID_OPTS: ManualLogCervicalFluid[] = ['Dry', 'Sticky', 'Creamy', 'Eggwhite'];
const POS_OPTS: ManualLogCervicalPosition[] = ['High', 'Medium', 'Low'];
const FIRM_OPTS: ManualLogCervicalFirmness[] = ['Soft', 'Firm'];
const DIST_OPTS: ManualLogDisturbance[] = ['Fever', 'Alcohol', 'Poor Sleep', 'Travel'];

type FormState = {
  manual_bbt: string;
  bbt_time_taken: string;
  exclude_temp: boolean;
  disturbances: ManualLogDisturbance[];
  cervical_position: ManualLogCervicalPosition | null;
  cervical_firmness: ManualLogCervicalFirmness | null;
  bleeding: ManualLogBleeding | null;
  intercourse: ManualLogIntercourse | null;
  cervical_fluid: ManualLogCervicalFluid | null;
  symptoms: string;
  test_results: string;
};

const emptyForm: FormState = {
  manual_bbt: '',
  bbt_time_taken: '07:30',
  exclude_temp: false,
  disturbances: [],
  cervical_position: null,
  cervical_firmness: null,
  bleeding: null,
  intercourse: null,
  cervical_fluid: null,
  symptoms: '',
  test_results: '',
};

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

const GRID_PAD = 16;

export default function CalendarScreen() {
  const firstDayOfWeek = useAppStore((s) => s.preferences.firstDayOfWeek);
  const dateFormat = useAppStore((s) => s.preferences.dateFormat);
  const isGhost = useAppStore((s) => s.isGhostModeEnabled);

  const cell = useMemo(() => {
    const w = Dimensions.get('window').width - GRID_PAD;
    return Math.max(40, Math.floor(w / 7));
  }, []);

  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()));
  const [fertileStart, setFertileStart] = useState<string | null>(null);
  const [fertileEnd, setFertileEnd] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedIso, setSelectedIso] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  const loadFertile = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setFertileStart(null);
      setFertileEnd(null);
      return;
    }
    const { data } = await supabase
      .from('cached_insight')
      .select('insight_text')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const ov = data?.insight_text ? parseInsightText(data.insight_text).estimatedOvulationDate : null;
    if (ov) {
      const o = parseIsoDate(ov);
      setFertileStart(isoDateString(addCalendarDays(o, -5)));
      setFertileEnd(isoDateString(addCalendarDays(o, 1)));
    } else {
      setFertileStart(null);
      setFertileEnd(null);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadFertile();
    }, [loadFertile]),
  );

  const monthLabel = useMemo(
    () =>
      monthCursor.toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
      }),
    [monthCursor],
  );

  const grid = useMemo(() => {
    const first = startOfMonth(monthCursor);
    const dim = daysInMonth(monthCursor);
    const jsDow = first.getDay();
    const leading =
      firstDayOfWeek === 'Monday' ? (jsDow === 0 ? 6 : jsDow - 1) : jsDow;
    const cells: ({ type: 'blank' } | { type: 'day'; iso: string; day: number })[] = [];
    for (let i = 0; i < leading; i++) cells.push({ type: 'blank' });
    for (let d = 1; d <= dim; d++) {
      const dt = new Date(first.getFullYear(), first.getMonth(), d);
      cells.push({ type: 'day', iso: isoDateString(dt), day: d });
    }
    while (cells.length % 7 !== 0) cells.push({ type: 'blank' });
    while (cells.length < 42) cells.push({ type: 'blank' });
    return cells;
  }, [monthCursor, firstDayOfWeek]);

  const isFertile = (iso: string) => {
    if (!fertileStart || !fertileEnd) return false;
    return iso >= fertileStart && iso <= fertileEnd;
  };

  const openForDate = async (iso: string) => {
    setSelectedIso(iso);
    setForm(emptyForm);
    if (isGhost) {
      const raw = ghostStorage.getString(`${GHOST_MANUAL_KEY_PREFIX}${iso}`);
      if (raw) {
        try {
          const o = JSON.parse(raw) as Record<string, unknown>;
          setForm({
            ...emptyForm,
            ...o,
            manual_bbt: typeof o.manual_bbt === 'string' ? o.manual_bbt : String(o.manual_bbt ?? ''),
            bbt_time_taken: typeof o.bbt_time_taken === 'string' ? o.bbt_time_taken : emptyForm.bbt_time_taken,
            exclude_temp: o.exclude_temp === true,
            disturbances: Array.isArray(o.disturbances)
              ? (o.disturbances as ManualLogDisturbance[])
              : [],
            cervical_position: (o.cervical_position as ManualLogCervicalPosition) ?? null,
            cervical_firmness: (o.cervical_firmness as ManualLogCervicalFirmness) ?? null,
            bleeding: (o.bleeding as ManualLogBleeding) ?? null,
            intercourse: (o.intercourse as ManualLogIntercourse) ?? null,
            cervical_fluid: (o.cervical_fluid as ManualLogCervicalFluid) ?? null,
            symptoms: Array.isArray(o.symptoms)
              ? (o.symptoms as string[]).join(', ')
              : typeof o.symptoms === 'string'
                ? o.symptoms
                : '',
            test_results: Array.isArray(o.test_results)
              ? (o.test_results as string[]).join(', ')
              : typeof o.test_results === 'string'
                ? o.test_results
                : '',
          });
        } catch {
          /* ignore */
        }
      }
      setSheetOpen(true);
      return;
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSheetOpen(true);
      return;
    }
    const { data } = await supabase
      .from('manual_logs')
      .select('*')
      .eq('user_id', user.id)
      .eq('date', iso)
      .maybeSingle();
    if (data) {
      const r = data as Record<string, unknown>;
      setForm({
        manual_bbt: r.manual_bbt != null ? String(r.manual_bbt) : '',
        bbt_time_taken:
          typeof r.bbt_time_taken === 'string' ? String(r.bbt_time_taken).slice(0, 5) : '07:30',
        exclude_temp: r.exclude_temp === true,
        disturbances: Array.isArray(r.disturbances) ? (r.disturbances as ManualLogDisturbance[]) : [],
        cervical_position: (r.cervical_position as ManualLogCervicalPosition) ?? null,
        cervical_firmness: (r.cervical_firmness as ManualLogCervicalFirmness) ?? null,
        bleeding: (r.bleeding as ManualLogBleeding) ?? null,
        intercourse: (r.intercourse as ManualLogIntercourse) ?? null,
        cervical_fluid: (r.cervical_fluid as ManualLogCervicalFluid) ?? null,
        symptoms: Array.isArray(r.symptoms) ? (r.symptoms as string[]).join(', ') : '',
        test_results: Array.isArray(r.test_results) ? (r.test_results as string[]).join(', ') : '',
      });
    }
    setSheetOpen(true);
  };

  const save = async () => {
    if (!selectedIso) return;
    setSaving(true);
    try {
      const symptomsArr = form.symptoms
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const testsArr = form.test_results
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (isGhost) {
        ghostStorage.set(
          `${GHOST_MANUAL_KEY_PREFIX}${selectedIso}`,
          JSON.stringify({
            ...form,
            symptoms: symptomsArr,
            test_results: testsArr,
          }),
        );
        setSheetOpen(false);
        return;
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const row = {
        user_id: user.id,
        date: selectedIso,
        manual_bbt: form.manual_bbt === '' ? null : Number(form.manual_bbt),
        bbt_time_taken: form.bbt_time_taken ? `${form.bbt_time_taken}:00` : null,
        exclude_temp: form.exclude_temp,
        disturbances: form.disturbances.length ? form.disturbances : null,
        cervical_position: form.cervical_position,
        cervical_firmness: form.cervical_firmness,
        bleeding: form.bleeding,
        intercourse: form.intercourse,
        cervical_fluid: form.cervical_fluid,
        symptoms: symptomsArr.length ? symptomsArr : null,
        test_results: testsArr.length ? testsArr : null,
      };
      const { data: existing } = await supabase
        .from('manual_logs')
        .select('id')
        .eq('user_id', user.id)
        .eq('date', selectedIso)
        .maybeSingle();
      if (existing?.id) {
        await supabase.from('manual_logs').update(row).eq('id', existing.id);
      } else {
        await supabase.from('manual_logs').insert(row);
      }
      setSheetOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const weekHeader =
    firstDayOfWeek === 'Monday'
      ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const toggleDist = (d: ManualLogDisturbance) => {
    setForm((f) => ({
      ...f,
      disturbances: f.disturbances.includes(d)
        ? f.disturbances.filter((x) => x !== d)
        : [...f.disturbances, d],
    }));
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.header}>
        <Pressable onPress={() => setMonthCursor((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>
          <Text style={styles.navBtn}>‹</Text>
        </Pressable>
        <Text style={styles.monthTitle}>{monthLabel}</Text>
        <Pressable onPress={() => setMonthCursor((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>
          <Text style={styles.navBtn}>›</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>
        {isGhost ? 'Ghost Mode: entries stay on-device only.' : 'Entries sync to your manual log.'}
      </Text>

      <View style={styles.weekRow}>
        {weekHeader.map((w) => (
          <Text key={w} style={[styles.weekLbl, { width: cell }]}>
            {w}
          </Text>
        ))}
      </View>

      <View style={[styles.grid, { paddingHorizontal: GRID_PAD / 2 }]}>
        {grid.map((c, idx) =>
          c.type === 'blank' ? (
            <View key={`b-${idx}`} style={{ width: cell, height: cell }} />
          ) : (
            <Pressable
              key={c.iso}
              onPress={() => void openForDate(c.iso)}
              style={[
                styles.cell,
                { width: cell, height: cell },
                isFertile(c.iso) && styles.fertile,
              ]}>
              <Text style={styles.dayNum}>{c.day}</Text>
            </Pressable>
          ),
        )}
      </View>

      <Modal visible={sheetOpen} animationType="slide" transparent onRequestClose={() => setSheetOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSheetOpen(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>
              {selectedIso
                ? formatCalendarDate(parseIsoDate(selectedIso), dateFormat, true)
                : 'Log'}
            </Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
              <Field label="Manual BBT">
                <TextInput
                  keyboardType="decimal-pad"
                  value={form.manual_bbt}
                  onChangeText={(t) => setForm((f) => ({ ...f, manual_bbt: t }))}
                  placeholder="e.g. 97.4"
                  style={styles.input}
                />
              </Field>
              <Field label="Time taken">
                <TextInput
                  value={form.bbt_time_taken}
                  onChangeText={(t) => setForm((f) => ({ ...f, bbt_time_taken: t }))}
                  placeholder="HH:MM"
                  style={styles.input}
                />
              </Field>
              <View style={styles.rowBetween}>
                <Text style={styles.fieldLbl}>Exclude temp from chart</Text>
                <Switch
                  value={form.exclude_temp}
                  onValueChange={(v) => setForm((f) => ({ ...f, exclude_temp: v }))}
                  trackColor={{ true: colors.primarySageGreen, false: colors.chartGrid }}
                />
              </View>
              <Field label="Disturbances">
                <View style={styles.chips}>
                  {DIST_OPTS.map((d) => (
                    <Pressable
                      key={d}
                      onPress={() => toggleDist(d)}
                      style={[styles.chip, form.disturbances.includes(d) && styles.chipOn]}>
                      <Text style={[styles.chipTxt, form.disturbances.includes(d) && styles.chipTxtOn]}>
                        {d}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </Field>
              <EnumRow
                label="Cervical position"
                options={POS_OPTS}
                value={form.cervical_position}
                onChange={(v) => setForm((f) => ({ ...f, cervical_position: v }))}
              />
              <EnumRow
                label="Cervical firmness"
                options={FIRM_OPTS}
                value={form.cervical_firmness}
                onChange={(v) => setForm((f) => ({ ...f, cervical_firmness: v }))}
              />
              <EnumRow
                label="Bleeding"
                options={BLEEDING_OPTS}
                value={form.bleeding}
                onChange={(v) => setForm((f) => ({ ...f, bleeding: v }))}
              />
              <EnumRow
                label="Intercourse"
                options={INTERCOURSE_OPTS}
                value={form.intercourse}
                onChange={(v) => setForm((f) => ({ ...f, intercourse: v }))}
              />
              <EnumRow
                label="Cervical fluid"
                options={FLUID_OPTS}
                value={form.cervical_fluid}
                onChange={(v) => setForm((f) => ({ ...f, cervical_fluid: v }))}
              />
              <Field label="Symptoms (comma-separated)">
                <TextInput
                  value={form.symptoms}
                  onChangeText={(t) => setForm((f) => ({ ...f, symptoms: t }))}
                  style={styles.input}
                  placeholder="Fatigue, cramping…"
                />
              </Field>
              <Field label="Test results (comma-separated)">
                <TextInput
                  value={form.test_results}
                  onChangeText={(t) => setForm((f) => ({ ...f, test_results: t }))}
                  style={styles.input}
                  placeholder="LH strip, HCG…"
                />
              </Field>
              <Pressable style={styles.saveBtn} onPress={() => void save()} disabled={saving}>
                <Text style={styles.saveTxt}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.fieldLbl}>{label}</Text>
      {children}
    </View>
  );
}

function EnumRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T | null;
  onChange: (v: T | null) => void;
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.fieldLbl}>{label}</Text>
      <View style={styles.chips}>
        <Pressable onPress={() => onChange(null)} style={[styles.chip, value == null && styles.chipOn]}>
          <Text style={[styles.chipTxt, value == null && styles.chipTxtOn]}>—</Text>
        </Pressable>
        {options.map((o) => (
          <Pressable
            key={o}
            onPress={() => onChange(o)}
            style={[styles.chip, value === o && styles.chipOn]}>
            <Text style={[styles.chipTxt, value === o && styles.chipTxtOn]}>{o}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  navBtn: { fontSize: 28, color: colors.primarySageGreen, paddingHorizontal: 12 },
  monthTitle: { fontSize: 20, fontWeight: '800', color: colors.textDark },
  hint: { paddingHorizontal: 16, marginTop: 6, color: colors.textMuted, fontSize: 13 },
  weekRow: { flexDirection: 'row', marginTop: 12, justifyContent: 'center' },
  weekLbl: { textAlign: 'center', fontSize: 12, fontWeight: '700', color: colors.textMuted },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  cell: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.chartGrid,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fertile: { backgroundColor: colors.fertileTint },
  dayNum: { fontSize: 16, fontWeight: '700', color: colors.textDark },
  modalRoot: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    maxHeight: '88%',
    backgroundColor: colors.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
  },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: colors.textDark, marginBottom: 12 },
  fieldLbl: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.chartGrid,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    color: colors.textDark,
    backgroundColor: colors.background,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.chartGrid,
    backgroundColor: colors.background,
  },
  chipOn: { backgroundColor: colors.primarySageGreen, borderColor: colors.primarySageGreen },
  chipTxt: { fontSize: 12, color: colors.textDark, fontWeight: '600' },
  chipTxtOn: { color: colors.card },
  saveBtn: {
    marginTop: 8,
    backgroundColor: colors.mutedCoral,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  saveTxt: { color: colors.card, fontWeight: '800', fontSize: 16 },
});
