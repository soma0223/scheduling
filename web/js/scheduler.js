// 空き時間の計算と、ToDo・習慣の自動配置（純粋関数・DOM非依存）
//
// 用語
//  - ユーザー予定: 手で入れた予定（auto=false）。前後に「余白」を確保する
//  - 自動ブロック: ToDo/習慣から自動配置された予定（auto=true, kind='todo'|'habit', ref=元ID）
//  - pinned: 自動ブロックをユーザーが手で動かしたもの。再配置で動かさない

import { toM, fm, ymd, pd, addDays, minutesOf, roundUp } from './util.js';

export const DEFAULT_SETTINGS = {
  dayStart: '07:00', // 活動開始
  dayEnd: '23:00', // 活動終了
  bufferBefore: 0, // ユーザー予定の前に空ける分
  bufferAfter: 0, // ユーザー予定の後に空ける分
  minFree: 30, // この分数以上の隙間を「空き時間」として表示
  minChunk: 30, // ToDo を分割するときの最小単位
  horizon: 7, // 何日先まで自動配置するか
  todoOrder: 'manual', // ToDo の割り振り順: 'manual'=手動の並び順 / 'due'=期限が近い順→優先度
  notify: [10], // 何分前に通知するか（複数可）
  theme: 'auto',
};

export const TODO_COLOR = '#d49a1a';
export const HABIT_COLOR = '#8b5cf6';

const timed = (e) => !e.deleted && e.start && e.end;

/** その日の予定を [開始, 終了] の占有区間に変換（ユーザー予定は余白込み）。結合・ソート済み */
export function busyIntervals(events, date, s) {
  const iv = events
    .filter((e) => timed(e) && e.date === date)
    .map((e) => {
      const a = toM(e.start), b = toM(e.end);
      return e.auto ? [a, b] : [a - (+s.bufferBefore || 0), b + (+s.bufferAfter || 0)];
    })
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** [lo, hi] の範囲で busy に重ならない区間（長さ制限なし） */
export function gaps(busy, lo, hi) {
  const out = [];
  let t = lo;
  for (const [a, b] of busy) {
    if (b <= t) continue;
    if (a >= hi) break;
    if (a > t) out.push([t, Math.min(a, hi)]);
    t = Math.max(t, b);
    if (t >= hi) break;
  }
  if (hi > t) out.push([t, hi]);
  return out;
}

/**
 * ToDo の並び順（一覧表示と自動配置で共通）
 *  manual: 手動で並べた順（order）。order が無いものは作成順で末尾
 *  due   : 期限が近い順 → 優先度（高い順） → 作成順
 */
export function todoCompare(s) {
  const created = (a, b) => String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id));
  if (s.todoOrder === 'due') {
    return (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (+b.priority || 2) - (+a.priority || 2) || created(a, b);
  }
  const ord = (t) => (Number.isFinite(+t.order) && t.order !== null && t.order !== '' ? +t.order : Infinity);
  return (a, b) => {
    const x = ord(a), y = ord(b);
    return x === y ? created(a, b) : x < y ? -1 : 1;
  };
}

/** その日の探索下限（今日なら現在時刻以降） */
function lowerBound(date, s, now) {
  const ds = toM(s.dayStart);
  if (now && date === ymd(now)) return Math.max(ds, roundUp(minutesOf(now), 5));
  return ds;
}

/** 表示用：minFree 分以上の空き時間 */
export function freeSlots(events, date, s, now) {
  const lo = lowerBound(date, s, now), hi = toM(s.dayEnd);
  if (now && date < ymd(now)) return [];
  return gaps(busyIntervals(events, date, s), lo, hi).filter(([a, b]) => b - a >= (+s.minFree || 30));
}

const sameAuto = (a, b) =>
  a.title === b.title && a.date === b.date && a.start === b.start && a.end === b.end &&
  a.color === b.color && !!a.pinned === !!b.pinned && a.ref === b.ref && a.kind === b.kind;

/**
 * ToDo・習慣を空き時間に自動配置する。
 * 既存の自動ブロックは、まだ有効（元が存在・未完了・衝突なし）ならそのまま残す（毎分ずれないように）。
 * 同じ入力からは同じ ID・同じ結果になるので、複数端末で同時に実行しても衝突しない。
 *
 * @returns {{upserts: object[], removes: string[], unplaced: {todos: object[], habits: object[]}}}
 */
export function plan({ events, todos, habits, settings }, now = new Date()) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const today = ymd(now), nowMin = minutesOf(now);
  const horizon = Math.max(1, Math.min(28, +s.horizon || 7));
  const days = Array.from({ length: horizon }, (_, i) => addDays(today, i));
  const lastDay = days[days.length - 1];
  const ds = toM(s.dayStart), de = toM(s.dayEnd);
  const minChunk = Math.max(5, +s.minChunk || 30);

  const live = events.filter((e) => !e.deleted);
  const todoMap = new Map(todos.filter((t) => !t.deleted).map((t) => [t.id, t]));
  const habitMap = new Map(habits.filter((h) => !h.deleted).map((h) => [h.id, h]));

  // 確定済みの予定（ここに配置済みブロックを積んでいく）
  const fixed = live.filter((e) => !e.auto);
  const keep = [];
  const removes = [];

  const started = (e) => e.date < today || (e.date === today && toM(e.start) < nowMin);
  const fitsDay = (e) => toM(e.start) >= ds && toM(e.end) <= de;
  const conflicts = (e, pool) => {
    const a = toM(e.start), b = toM(e.end);
    return busyIntervals(pool, e.date, s).some(([x, y]) => a < y && b > x);
  };

  // --- 1. 既存の自動ブロックを仕分け ---
  const autos = live.filter((e) => e.auto).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const futureByTodo = new Map();
  for (const a of autos) {
    const src = a.kind === 'todo' ? todoMap.get(a.ref) : habitMap.get(a.ref);
    if (!src) { removes.push(a.id); continue; } // 元が消えた
    if (started(a)) { keep.push(a); continue; } // 開始済み・過去は履歴として残す
    if (a.kind === 'todo' && src.done) { removes.push(a.id); continue; }
    if (a.kind === 'habit' && (src.skip || []).includes(a.date)) { removes.push(a.id); continue; }
    if (a.pinned) { keep.push(a); continue; }
    if (a.date > lastDay) { removes.push(a.id); continue; }
    if (a.kind === 'habit') {
      const ok = (src.days || []).includes(pd(a.date).getDay()) && !(src.skip || []).includes(a.date) &&
        toM(a.start) >= toM(src.from || s.dayStart) && toM(a.end) <= toM(src.to || s.dayEnd) &&
        toM(a.end) - toM(a.start) === (+src.minutes || 30) &&
        fitsDay(a) && !conflicts(a, [...fixed, ...keep]) &&
        !keep.some((k) => k.kind === 'habit' && k.ref === a.ref && k.date === a.date);
      if (ok) keep.push(a); else removes.push(a.id);
    } else {
      if (!futureByTodo.has(a.ref)) futureByTodo.set(a.ref, []);
      futureByTodo.get(a.ref).push(a);
    }
  }

  // ToDo の残り必要時間（進行中ブロックぶんは差し引く。終わったのに未完了なら再度確保）
  const need = new Map();
  for (const t of todoMap.values()) {
    if (t.done || !(+t.minutes > 0)) continue;
    const running = keep
      .filter((k) => k.kind === 'todo' && k.ref === t.id && k.date === today && toM(k.end) > nowMin)
      .reduce((a, k) => a + toM(k.end) - Math.max(toM(k.start), 0), 0);
    const pinnedFuture = keep
      .filter((k) => k.kind === 'todo' && k.ref === t.id && k.pinned && !started(k))
      .reduce((a, k) => a + toM(k.end) - toM(k.start), 0);
    need.set(t.id, Math.max(0, +t.minutes - running - pinnedFuture));
  }

  // 既存の ToDo ブロック群：全部まだ有効で、合計がちょうど必要量なら残す。それ以外は作り直す
  for (const [ref, list] of futureByTodo) {
    const n = need.get(ref) || 0;
    const total = list.reduce((a, e) => a + toM(e.end) - toM(e.start), 0);
    const pool = [...fixed, ...keep];
    const valid = list.every((e) => fitsDay(e) && !conflicts(e, pool) && !conflicts(e, list.filter((x) => x !== e)));
    if (valid && total === n && n > 0) { keep.push(...list); need.set(ref, 0); }
    else removes.push(...list.map((e) => e.id));
  }

  const placed = [];
  const pool = () => [...fixed, ...keep, ...placed];
  const freeOn = (date, lo, hi) => gaps(busyIntervals(pool(), date, s), Math.max(lo, lowerBound(date, s, now)), hi);
  const unplaced = { todos: [], habits: [] };

  // --- 2. 習慣：曜日・時間帯の範囲で最初に入る空きへ ---
  const habitList = [...habitMap.values()].sort(
    (a, b) => toM(a.to) - toM(a.from) - (toM(b.to) - toM(b.from)) || a.id.localeCompare(b.id),
  );
  for (const d of days) {
    const wd = pd(d).getDay();
    for (const h of habitList) {
      if (!(h.days || []).includes(wd) || (h.skip || []).includes(d)) continue;
      if (keep.some((k) => k.kind === 'habit' && k.ref === h.id && k.date === d)) continue;
      const m = +h.minutes || 30;
      const lo = Math.max(ds, toM(h.from || s.dayStart)), hi = Math.min(de, toM(h.to || s.dayEnd));
      const g = freeOn(d, lo, hi).find(([a, b]) => b - a >= m);
      if (!g) {
        // 今日のもう過ぎた時間帯は「未配置」扱いにしない
        if (!(d === today && lowerBound(d, s, now) + m > hi)) unplaced.habits.push({ id: h.id, date: d });
        continue;
      }
      placed.push(autoEvent('habit', h, d, g[0], g[0] + m, `auto-h-${h.id}-${d}`));
    }
  }

  // --- 3. ToDo：設定した順（手動 or 期限順）に、上のものから空きを埋めていく ---
  const todoList = [...todoMap.values()]
    .filter((t) => (need.get(t.id) || 0) > 0)
    .sort(todoCompare(s));
  for (const t of todoList) {
    let rest = need.get(t.id);
    const before = days.filter((d) => !t.due || d <= t.due);
    const after = days.filter((d) => t.due && d > t.due);
    const put = (d, a, b) => placed.push(autoEvent('todo', t, d, a, b, `auto-t-${t.id}-${d}-${fm(a).replace(':', '')}`));

    const whole = (ds_) => {
      for (const d of ds_) {
        const g = freeOn(d, ds, de).find(([a, b]) => b - a >= rest);
        if (g) { put(d, g[0], g[0] + rest); rest = 0; return true; }
      }
      return false;
    };
    const split = (ds_) => {
      for (const d of ds_) {
        for (const [a, b] of freeOn(d, ds, de)) {
          if (rest <= 0) return;
          let len = Math.min(b - a, rest);
          if (len < rest && rest - len < minChunk) len = rest - minChunk; // 端数を残さない
          if (len < Math.min(minChunk, rest)) continue;
          put(d, a, a + len);
          rest -= len;
        }
      }
    };
    if (!whole(before)) split(before);
    if (rest > 0 && !whole(after)) split(after);
    if (rest > 0) unplaced.todos.push({ id: t.id, minutes: rest });
  }

  // --- 4. 差分 ---
  const current = new Map(events.map((e) => [e.id, e]));
  const removeSet = new Set(removes);
  const upserts = [];
  for (const p of placed) {
    removeSet.delete(p.id);
    const c = current.get(p.id);
    if (!c || c.deleted || !sameAuto(c, p)) upserts.push(p);
  }
  return { upserts, removes: [...removeSet].filter((id) => current.get(id) && !current.get(id).deleted), unplaced };
}

function autoEvent(kind, src, date, a, b, id) {
  return {
    id,
    title: src.title,
    date,
    start: fm(a),
    end: fm(b),
    memo: '',
    color: src.color || (kind === 'todo' ? TODO_COLOR : HABIT_COLOR),
    auto: true,
    kind,
    ref: src.id,
    pinned: false,
  };
}

/** 週ストリップの各日について、空きの合計分 */
export function freeTotal(events, date, s, now) {
  return freeSlots(events, date, s, now).reduce((a, [x, y]) => a + y - x, 0);
}

