import type { DateFormat } from '@/src/types/database';

export function formatCalendarDate(
  d: Date,
  dateFormat: DateFormat,
  weekday?: boolean,
): string {
  const w = weekday
    ? d.toLocaleDateString(undefined, { weekday: 'short' })
    : '';
  let core: string;
  if (dateFormat === 'DD/MM/YYYY') {
    core = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  } else {
    core = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
  }
  return weekday ? `${w} · ${core}` : core;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Clinical / export timestamps: calendar date per user preference + local 12-hour clock. */
export function formatClinicalDateTime(d: Date, dateFormat: DateFormat): string {
  let datePart: string;
  if (dateFormat === 'DD/MM/YYYY') {
    datePart = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  } else {
    datePart = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
  }
  const h24 = d.getHours();
  const min = pad(d.getMinutes());
  const h12 = h24 % 12 || 12;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  return `${datePart} ${h12}:${min} ${ampm}`;
}

export function isoDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

export function addCalendarDays(d: Date, days: number): Date {
  const n = new Date(d.getTime());
  n.setDate(n.getDate() + days);
  return n;
}
