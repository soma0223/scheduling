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

/** 繰り返しの親（date・repeat・skip を持つもの）の、from〜to（含む）に回がある日付の一覧 */
export function occurrenceDates(base, from, to) {
  const out = [];
  const skip = new Set(base.skip || []);
  const lastByCount = lastDateByCount(base);
  const until = [base.repeat.until, lastByCount].filter(Boolean).sort()[0] || ''; // 日付と回数の早いほうで終わり
  for (let d = from > base.date ? from : base.date; d <= to; d = addDays(d, 1)) {
    if (until && d > until) break;
    if (!matches(base, d) || skip.has(d)) continue;
    out.push(d);
  }
  return out;
}

/** 繰り返しの親を、from〜to（含む）の各回に展開する。それ以外の予定はそのまま通す */
export function expandEvents(list, from, to) {
  const out = [];
  for (const e of list) {
    if (!isRecurring(e) || e.deleted) { out.push(e); continue; }
    for (const d of occurrenceDates(e, from, to)) out.push({ ...e, id: `${e.id}@${d}`, date: d, series: e.id });
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

// ---- くり返しの ToDo（例：毎週水曜に出る課題を、木曜までにやる）----
//  雛形（template:true, repeat:{days, every, until, count, dueAfter}）から、回ごとに通常の ToDo を1件ずつ作る。
//  各回は start（出た日）〜 due（出た日の dueAfter 日後）のあいだの空きに自動配置される。

export const isTodoTemplate = (t) => !!(t && t.template && t.repeat && Array.isArray(t.repeat.days) && t.repeat.days.length);

/** 雛形から、今日（today）〜 last に出る回の ToDo を作る。すでに期限が過ぎた回は作らない */
export function repeatTodoInstances(tpl, today, last) {
  if (!isTodoTemplate(tpl)) return [];
  const after = Math.max(0, Math.min(30, Math.round(+tpl.repeat.dueAfter || 0)));
  const out = [];
  for (const d of occurrenceDates(tpl, addDays(today, -after), last)) {
    const due = addDays(d, after);
    if (due < today) continue;
    out.push({
      id: `${tpl.id}@${d}`, series: tpl.id, title: tpl.title, minutes: tpl.minutes, priority: tpl.priority || 2,
      memo: tpl.memo || '', places: tpl.places || [], after: tpl.after || null, notBefore: tpl.notBefore || '', notAfter: tpl.notAfter || '', prefer: tpl.prefer || '',
      estSource: tpl.estSource, estReason: tpl.estReason, start: d, due, done: false, createdAt: d,
      order: Date.parse(d + 'T12:00:00Z'), // 出た順（先に出たものが上）
    });
  }
  return out;
}

/** 「毎週 水 → 期限は出た日の1日後」のような説明 */
export function describeTodoRepeat(rep, WD) {
  const after = Math.round(+rep.dueAfter || 0);
  return `${describeRepeat(rep, WD)} → 期限は${after ? `出た日の${after}日後` : '出た日のうち'}`;
}
