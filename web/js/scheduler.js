// 空き時間の計算と、ToDo・習慣の自動配置（純粋関数・DOM非依存）
//
// 用語
//  - ユーザー予定: 手で入れた予定（auto=false）。前後に「余白」を確保する
//  - 自動ブロック: ToDo/習慣から自動配置された予定（auto=true, kind='todo'|'habit', ref=元ID）
//  - pinned: 自動ブロックをユーザーが手で動かしたもの。再配置で動かさない

import { toM, fm, ymd, pd, addDays, minutesOf, roundUp } from './util.js';
import { DEFAULT_PLACES, hasConstraint, isTransit, matchesKey, placeOfGap } from './constraints.js';

export const DEFAULT_SETTINGS = {
  dayStart: '07:00', // 活動開始
  dayEnd: '23:00', // 活動終了
  dayEndNext: false, // true なら終了は翌日（例：07:00〜翌02:00）
  bufferBefore: 0, // ユーザー予定の前に空ける分
  bufferAfter: 0, // ユーザー予定の後に空ける分
  minFree: 30, // この分数以上の隙間を「空き時間」として表示
  minChunk: 30, // ToDo を分割するときの最小単位
  horizon: 7, // 何日先まで自動配置するか
  places: DEFAULT_PLACES, // 場所の一覧（予定・ToDo・習慣の条件に使う）
  home: '家', // 予定のない時間にいる場所
  constrainedFirst: '1', // 場所などの条件があるものを先に配置する（'1'=する）
  todoOrder: 'manual', // ToDo の割り振り順: 'manual'=手動の並び順 / 'due'=期限が近い順→優先度
  notify: [10], // 何分前に通知するか（複数可）
  theme: 'auto',
};

export const TODO_COLOR = '#d49a1a';
export const HABIT_COLOR = '#8b5cf6';

// ---- 「論理日」：活動時間が日付をまたぐとき（例 7:00〜翌2:00）----
// 深夜0〜2時の予定は前日の夜の続きとして扱う。内部では前日の 24:00〜26:00 として計算し、
// 保存するときだけ実際の日付・時刻に戻す。

/** 活動時間の範囲（分）。翌日終了なら de > 1440 */
export function dayBounds(s) {
  const ds = toM(s.dayStart);
  let de = toM(s.dayEnd);
  if (de <= ds) de += 1440; // 終了が開始以前なら翌日（保存されたフラグに頼らない）
  return { ds, de };
}

/** 「いま」が属する論理日と、その日の何分か */
export function logicalNow(now, s) {
  const { de } = dayBounds(s);
  const m = minutesOf(now);
  if (de > 1440 && m < de - 1440) return { date: addDays(ymd(now), -1), min: m + 1440 };
  return { date: ymd(now), min: m };
}

/** 実際の予定 → 論理日の予定（何度かけても同じ結果） */
export function normalizeEvent(e, s) {
  const { de } = dayBounds(s);
  if (de > 1440 && e.date && e.start && e.end && toM(e.start) < de - 1440) {
    return { ...e, date: addDays(e.date, -1), start: fm(toM(e.start) + 1440), end: fm(toM(e.end) + 1440) };
  }
  return e;
}
export const normalizeEvents = (list, s) => list.map((e) => normalizeEvent(e, s));

/** 論理日の予定 → 実際の日付・時刻 */
export function denormalizeEvent(e) {
  if (e.start && toM(e.start) >= 1440) {
    return { ...e, date: addDays(e.date, 1), start: fm(toM(e.start) - 1440), end: fm(toM(e.end) - 1440) };
  }
  return e;
}

/** 区間を 24:00 の境目で分ける（自動配置の枠が日付をまたがないように） */
const splitMidnight = (list) => list.flatMap(([a, b]) => (a < 1440 && b > 1440 ? [[a, 1440], [1440, b]] : [[a, b]]));

/** 習慣の時間帯（分）。終了が開始以前なら翌日扱い。深夜の時間帯は活動時間の翌日側に寄せる */
function habitWindow(h, s) {
  const { ds, de } = dayBounds(s);
  let f = toM(h.from || s.dayStart);
  let t = h.to ? toM(h.to) : de;
  if (h.to && t <= f) t += 1440;
  if (de > 1440 && f < ds && f + 1440 < de) { f += 1440; t += 1440; }
  return [Math.max(ds, f), Math.min(de, t)];
}

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
  const { ds } = dayBounds(s);
  if (now) {
    const ln = logicalNow(now, s);
    if (date === ln.date) return Math.max(ds, roundUp(ln.min, 5));
  }
  return ds;
}

/** 表示用：minFree 分以上の空き時間 */
export function freeSlots(events, date, s, now) {
  const lo = lowerBound(date, s, now), hi = dayBounds(s).de;
  if (now && date < logicalNow(now, s).date) return [];
  return gaps(busyIntervals(normalizeEvents(events, s), date, s), lo, hi).filter(([a, b]) => b - a >= (+s.minFree || 30));
}

/**
 * item（ToDo/習慣）が入れられる区間の一覧。poolArr は「その時点で埋まっている予定」。
 * 場所の条件があれば、その場所とみなせる隙間（と移動中の予定の中）だけに絞り、
 * 「◯◯のあとから」があれば、その日の該当予定の終了＋指定時間より前を落とす。
 */
function candidatesFor(item, date, poolArr, lo, hi, s) {
  const free = gaps(busyIntervals(poolArr, date, s), lo, hi);
  if (!hasConstraint(item)) return splitMidnight(free);
  const day = poolArr.filter((e) => !e.deleted && e.date === date && e.start && e.end);
  const users = day.filter((e) => !e.auto).sort((a, b) => toM(a.start) - toM(b.start));
  const placedEv = users.filter((e) => e.place);
  let out = free;
  const allowed = item.places || [];
  if (allowed.length) {
    out = free.filter(([a, b]) => allowed.includes(placeOfGap(placedEv, a, b, s)));
    const autoBusy = busyIntervals(day.filter((e) => e.auto), date, s);
    for (const e of placedEv) {
      if (!isTransit(e.place, s) || !allowed.includes(e.place)) continue;
      const a = Math.max(toM(e.start), lo), b = Math.min(toM(e.end), hi);
      if (b > a) out = out.concat(gaps(autoBusy, a, b));
    }
    out = out.slice().sort((x, y) => x[0] - y[0]);
  }
  const key = item.after && item.after.key;
  if (key) {
    const ends = users.filter((e) => matchesKey(e, key)).map((e) => toM(e.end));
    if (ends.length) {
      const lo2 = Math.max(...ends) + (+item.after.min || 0);
      out = out.map(([a, b]) => [Math.max(a, lo2), b]).filter(([a, b]) => b > a);
    }
  }
  return splitMidnight(out);
}

const sameAuto = (a, b) =>
  a.title === b.title && a.date === b.date && a.start === b.start && a.end === b.end &&
  a.color === b.color && !!a.pinned === !!b.pinned && a.ref === b.ref && a.kind === b.kind;

/**
 * ToDo・習慣を空き時間に自動配置する。
 * 既存の自動ブロックは、まだ有効（元が存在・未完了・衝突なし）ならそのまま残す（毎分ずれないように）。
 * 同じ入力からは同じ ID・同じ結果になるので、複数端末で同時に実行しても衝突しない。
 *
 * fresh=true なら、まだ始まっていない固定でない自動ブロックをいったん全部白紙に戻して並び順どおりに置き直す
 *（「再配置」ボタン・並び順や優先設定の変更時）。
 *
 * @returns {{upserts: object[], removes: string[], unplaced: {todos: object[], habits: object[]}}}
 */
export function plan({ events, todos, habits, settings }, now = new Date(), { fresh = false } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const { date: today, min: nowMin } = logicalNow(now, s);
  const horizon = Math.max(1, Math.min(28, +s.horizon || 7));
  const days = Array.from({ length: horizon }, (_, i) => addDays(today, i));
  const lastDay = days[days.length - 1];
  const { ds, de } = dayBounds(s);
  const minChunk = Math.max(5, +s.minChunk || 30);

  const live = normalizeEvents(events, s).filter((e) => !e.deleted);
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
  // 既存ブロックが（場所・「あとから」の条件も含めて）まだ有効か。poolArr に e 自身は含めないこと
  const okBlock = (e, src, poolArr) => {
    if (!hasConstraint(src)) return !conflicts(e, poolArr);
    const a = toM(e.start), b = toM(e.end);
    return candidatesFor(src, e.date, poolArr, ds, de, s).some(([x, y]) => x <= a && b <= y);
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
    if (fresh) { removes.push(a.id); continue; }
    if (a.date > lastDay) { removes.push(a.id); continue; }
    if (a.kind === 'habit') {
      const ok = (src.days || []).includes(pd(a.date).getDay()) && !(src.skip || []).includes(a.date) &&
        toM(a.start) >= habitWindow(src, s)[0] && toM(a.end) <= habitWindow(src, s)[1] &&
        toM(a.end) - toM(a.start) === (+src.minutes || 30) &&
        fitsDay(a) && okBlock(a, src, [...fixed, ...keep]) &&
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
      .filter((k) => k.kind === 'todo' && k.ref === t.id && k.date === today && started(k) && toM(k.end) > nowMin)
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
    const src = todoMap.get(ref);
    const valid = list.every((e) => fitsDay(e) && okBlock(e, src, [...pool, ...list.filter((x) => x !== e)]));
    if (valid && total === n && n > 0) { keep.push(...list); need.set(ref, 0); }
    else removes.push(...list.map((e) => e.id));
  }

  const placed = [];
  const pool = () => [...fixed, ...keep, ...placed];
  const cand = (item, date, lo, hi) => candidatesFor(item, date, pool(), Math.max(lo, lowerBound(date, s, now)), hi, s);
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
      const [lo, hi] = habitWindow(h, s);
      const g = cand(h, d, lo, hi).find(([a, b]) => b - a >= m);
      if (!g) {
        // 今日のもう過ぎた時間帯は「未配置」扱いにしない
        if (!(d === today && lowerBound(d, s, now) + m > hi)) unplaced.habits.push({ id: h.id, date: d });
        continue;
      }
      placed.push(autoEvent('habit', h, d, g[0], g[0] + m, `auto-h-${h.id}-${d}`));
    }
  }

  // --- 3. ToDo：設定した順（手動 or 期限順）に、上のものから空きを埋めていく ---
  let todoList = [...todoMap.values()]
    .filter((t) => (need.get(t.id) || 0) > 0)
    .sort(todoCompare(s));
  // 条件つき（場所など）は入れる枠が限られるので先に配置する。条件なしの ToDo が貴重な枠を先に使わないように
  if (String(s.constrainedFirst) !== '0') todoList = [...todoList.filter(hasConstraint), ...todoList.filter((t) => !hasConstraint(t))];
  for (const t of todoList) {
    let rest = need.get(t.id);
    const before = days.filter((d) => !t.due || d <= t.due);
    const after = days.filter((d) => t.due && d > t.due);
    const put = (d, a, b) => placed.push(autoEvent('todo', t, d, a, b, `auto-t-${t.id}-${d}-${fm(a).replace(':', '')}`));

    const whole = (ds_) => {
      for (const d of ds_) {
        const g = cand(t, d, ds, de).find(([a, b]) => b - a >= rest);
        if (g) { put(d, g[0], g[0] + rest); rest = 0; return true; }
      }
      return false;
    };
    const split = (ds_) => {
      for (const d of ds_) {
        for (const [a, b] of cand(t, d, ds, de)) {
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
  for (const p0 of placed) {
    const p = denormalizeEvent(p0); // 保存用に実際の日付・時刻へ
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

