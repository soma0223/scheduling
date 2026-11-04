// タイムゾーンつきの日付・時刻計算（Edge Function 用。依存なし）

/** ある瞬間(ms)のタイムゾーン tz の UTC からのずれ(ms) */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

/** tz での日付 'YYYY-MM-DD' と時刻 'HH:MM' → UTC の ms */
export function localToUTC(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall - tzOffsetMs(wall, tz);
  t = wall - tzOffsetMs(t, tz); // 夏時間の境目でのずれを補正
  return t;
}

/** ある瞬間(ms)の tz での日付 'YYYY-MM-DD' */
export function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** 曜日 0(日)〜6(土)。日付だけで決まる（タイムゾーン不要） */
export const weekdayOf = (date: string): number => new Date(date + 'T00:00:00Z').getUTCDay();

// ---- 繰り返しのルール（web/js/recurrence.js と同じ。変えるときは両方）----
const addDaysStr = (date: string, n: number): string => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (date: string): string => addDaysStr(date, -((weekdayOf(date) + 6) % 7));
const weeksBetween = (a: string, b: string): number =>
  Math.round((Date.parse(mondayOf(b) + 'T00:00:00Z') - Date.parse(mondayOf(a) + 'T00:00:00Z')) / (7 * 864e5));

/** 親の日付 start から数えて、日付 d に回があるか（スキップ・終わりは見ない） */
function matches(start: string, rp: Record<string, any>, d: string): boolean {
  return d >= start && rp.days.includes(weekdayOf(d)) && weeksBetween(start, d) % Math.max(1, +rp.every || 1) === 0;
}

/** 回数（count）で終わるときの最後の回の日付。指定が無ければ '' */
function lastDateByCount(start: string, rp: Record<string, any>): string {
  const n = Math.round(+rp.count || 0);
  if (n <= 0) return '';
  let c = 0;
  for (let i = 0; i < 2000; i++) {
    const d = addDaysStr(start, i);
    if (matches(start, rp, d) && ++c >= n) return d;
  }
  return '';
}

type Rec = { user_id: string; id: string; data: Record<string, any> };

/**
 * 繰り返しの予定（親）から、[loMs, hiMs] に開始する「回」を取り出す。
 * 戻り値は通常の予定と同じ形（id は `親id@日付`）。
 */
export function recurringInstances(masters: Rec[], nowMs: number, loMs: number, hiMs: number) {
  const out: { user_id: string; id: string; data: Record<string, any>; starts_at: string }[] = [];
  for (const r of masters) {
    const d = r.data ?? {};
    const rp = d.repeat;
    if (!rp?.days?.length || !d.start || !d.date) continue;
    const tz = rp.tz || 'Asia/Tokyo';
    const skip = new Set<string>(d.skip ?? []);
    const until = [rp.until, lastDateByCount(d.date, rp)].filter(Boolean).sort()[0] || '';
    const seen = new Set<string>();
    for (let k = -1; k <= 2; k++) {
      const day = localDate(nowMs + k * 864e5, tz);
      if (seen.has(day)) continue;
      seen.add(day);
      if (day < d.date || (until && day > until) || skip.has(day)) continue;
      if (!matches(d.date, rp, day)) continue;
      const startMs = localToUTC(day, d.start, tz);
      if (startMs < loMs || startMs > hiMs) continue;
      out.push({ user_id: r.user_id, id: `${r.id}@${day}`, data: { ...d, date: day }, starts_at: new Date(startMs).toISOString() });
    }
  }
  return out;
}
