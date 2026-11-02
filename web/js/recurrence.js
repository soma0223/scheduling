// 曜日での繰り返し予定
//  - 繰り返しの予定は「親」1件だけ保存する: repeat = { days:[0-6], until:'YYYY-MM-DD'|'', tz }, skip = ['YYYY-MM-DD'] (その日だけ削除)
//  - 表示・計算のときだけ、期間内の各日の「回」に展開する（id は `${親id}@${日付}`、series=親id）
//  - 日付・曜日は実際のカレンダー日で数える（深夜の「論理日」への寄せは、展開したあとに行う）

import { pd, addDays } from './util.js';

export const isRecurring = (e) => !!(e && !e.series && e.repeat && Array.isArray(e.repeat.days) && e.repeat.days.length);

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
    const until = e.repeat.until || '';
    for (let d = from > e.date ? from : e.date; d <= to; d = addDays(d, 1)) {
      if (until && d > until) break;
      if (!e.repeat.days.includes(pd(d).getDay()) || skip.has(d)) continue;
      out.push({ ...e, id: `${e.id}@${d}`, date: d, series: e.id });
    }
  }
  return out;
}

/** 「毎週 月・水・金」のような説明 */
export function describeRepeat(rep, WD) {
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => rep.days.includes(d));
  const days = order.length === 7 ? '毎日' : '毎週 ' + order.map((d) => WD[d]).join('・');
  return days + (rep.until ? `（${rep.until}まで）` : '');
}
