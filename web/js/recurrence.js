// 曜日での繰り返し予定
//  - 繰り返しの予定は「親」1件だけ保存する: repeat = { days:[0-6], every:1|2|3|4 (週おき), until:'YYYY-MM-DD'|'' (この日まで), count:N|0 (全N回), tz }、
//    skip = ['YYYY-MM-DD'] (その日だけ削除。回数には数える)
//  - 隔週などは、親の日付がある週（月曜はじまり）を基準に数える
//  - 表示・計算のときだけ、期間内の各日の「回」に展開する（id は `${親id}@${日付}`、series=親id）
//  - 日付・曜日は実際のカレンダー日で数える（深夜の「論理日」への寄せは、展開したあとに行う）

import { pd, addDays } from './util.js';

export const isRecurring = (e) => !!(e && !e.series && e.repeat && Array.isArray(e.repeat.days) && e.repeat.days.length);

const mondayOf = (date) => addDays(date, -((pd(date).getDay() + 6) % 7));
const weeksBetween = (a, b) => Math.round((pd(mondayOf(b)) - pd(mondayOf(a))) / (7 * 864e5));

/** 繰り返しのルール上、日付 d に回があるか（スキップ・終わりは見ない） */
const matches = (e, d) => d >= e.date && e.repeat.days.includes(pd(d).getDay()) && weeksBetween(e.date, d) % Math.max(1, +e.repeat.every || 1) === 0;

/** 回数（count）で終わるとき、最後の回の日付。回数の指定が無ければ '' */
function lastDateByCount(e) {
  const n = Math.round(+e.repeat.count || 0);
  if (n <= 0) return '';
  let c = 0;
  for (let i = 0; i < 2000; i++) {
    const d = addDays(e.date, i);
    if (matches(e, d) && ++c >= n) return d;
  }
  return '';
}

/** 日付 date 以降で、days のどれかの曜日になる最初の日 */
export function nextMatching(date, days) {
  for (let i = 0; i < 7; i++) {
    const d = addDays(date, i);
    if (days.includes(pd(d).getDay())) return d;
  }
  return date;
}

/** 繰り返しの親を、from〜to（含む）の各回に展開する。それ以外の予定はそのまま通す */
export function expandEvents(list, from, to) {
  const out = [];
  for (const e of list) {
    if (!isRecurring(e) || e.deleted) { out.push(e); continue; }
    const skip = new Set(e.skip || []);
    const lastByCount = lastDateByCount(e);
    const until = [e.repeat.until, lastByCount].filter(Boolean).sort()[0] || ''; // 日付と回数の早いほうで終わり
    for (let d = from > e.date ? from : e.date; d <= to; d = addDays(d, 1)) {
      if (until && d > until) break;
      if (!matches(e, d) || skip.has(d)) continue;
      out.push({ ...e, id: `${e.id}@${d}`, date: d, series: e.id });
    }
  }
  return out;
}

/** 「毎週 月・水・金」のような説明 */
export function describeRepeat(rep, WD) {
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => rep.days.includes(d));
  const ev = Math.max(1, +rep.every || 1);
  const every = ev === 1 ? '毎週' : ev === 2 ? '隔週' : `${ev}週ごと`;
  const days = order.length === 7 && ev === 1 ? '毎日' : `${every} ${order.map((d) => WD[d]).join('・')}`;
  return days + (+rep.count > 0 ? `（全${Math.round(+rep.count)}回）` : rep.until ? `（${rep.until}まで）` : '');
}
