// 場所・「◯◯のあとから」の条件まわり（純粋関数）
//
// 場所のモデル
//  - 予定は place（場所名）を持てる。設定の places に { name, transit } を登録する
//    transit=true は「電車」のような移動中の場所。移動中の予定のなかでは、その場所でできる作業を入れられる
//  - 予定の入っていない時間の場所は、前後の「場所つき予定」から推定する
//      その日の最初の予定より前／最後の予定より後 … ふだんいる場所（home）
//      前後が同じ場所 … その場所（例：授業と授業のあいだは学校）
//      移動中の予定の前後 … 出発前は前の場所、到着後は次の場所
//      それ以外（場所が食い違う）… 不明。場所の条件があるものは入れない

import { toM, fm } from './util.js';

export const DEFAULT_PLACES = [
  { name: '家', transit: false },
  { name: '学校', transit: false },
  { name: '職場', transit: false },
];

// 移動手段。work=true は乗っている間に作業できる（電車・バス）
export const DEFAULT_MODES = [
  { name: '徒歩', work: false },
  { name: '自転車', work: false },
  { name: '電車', work: true },
  { name: 'バス', work: true },
  { name: '車', work: false },
];

/** 場所または「あとから」の条件を持つか */
export const hasConstraint = (x) => !!(x && ((x.places || []).length || (x.after && x.after.key) || x.notBefore || x.notAfter));

/** 移動中の場所か（移動手段、または「移動中」にした場所） */
export const isTransit = (name, s) =>
  name === '移動' || !!(s.places || []).find((p) => p.name === name)?.transit || !!(s.modes || []).find((m) => m.name === name);

/** ToDo・習慣の「できる場所」の候補：場所＋作業できる移動手段 */
export const taskPlaceNames = (s) => [...new Set([
  ...(s.places || []).map((p) => p.name),
  ...(s.modes || []).filter((m) => m.work).map((m) => m.name),
])];
/** 予定の「場所」の候補：場所＋移動手段すべて */
export const eventPlaceNames = (s) => [...new Set([...(s.places || []).map((p) => p.name), ...(s.modes || []).map((m) => m.name)])];

/**
 * 場所が変わる予定のあいだに「移動」の時間を作る（仮想の予定）。
 *  - 予定の場所が前の場所（その日の最初は「ふだんいる場所」）と違い、ルート（from⇔to）があれば、
 *    次の予定の開始までに着くように、直前に移動時間を確保する
 *  - 予定ごとの travel（手段・時間）があればルートより優先。minutes=0 は「移動なし」
 *  - その日の最後の予定が家以外なら、終了後に家までの移動を確保する
 *  - 間に「電車」などの移動中の予定を自分で入れているときは作らない
 * @param events 論理日に直した、自動配置でない予定
 */
export function travelSegments(events, s) {
  const routes = s.routes || [];
  if (!routes.length && !events.some((e) => e.travel)) return [];
  const home = s.home || '家';
  const find = (a, b) => routes.find((r) => (r.from === a && r.to === b) || (r.from === b && r.to === a));
  const byDate = new Map();
  for (const e of events) {
    if (e.deleted || e.auto || e.virtual || !e.start || !e.end || !e.place) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const out = [];
  const seg = (id, date, a, b, from, to, mode) => ({
    id, title: `${mode || '移動'} ${from}→${to}`, date, start: fm(a), end: fm(b), color: '#9aa1ab',
    virtual: true, travel: true, place: mode || '移動', from, to, minutes: b - a,
  });
  for (const [date, list] of byDate) {
    list.sort((a, b) => toM(a.start) - toM(b.start));
    const moving = list.filter((e) => isTransit(e.place, s));
    const stays = list.filter((e) => !isTransit(e.place, s));
    let prevPlace = home, prevEnd = 0;
    for (const e of stays) {
      if (e.place !== prevPlace) {
        const r = find(prevPlace, e.place), ov = e.travel;
        const m = ov && ov.minutes !== null && ov.minutes !== undefined && ov.minutes !== '' ? +ov.minutes : r ? +r.minutes : 0;
        const mode = (ov && ov.mode) || (r && r.mode) || '';
        const es = toM(e.start);
        if (m > 0 && !moving.some((x) => toM(x.start) >= prevEnd && toM(x.end) <= es)) {
          const a = Math.max(es - m, prevEnd);
          if (es > a) out.push(seg(`travel-${e.id}`, date, a, es, prevPlace, e.place, mode));
        }
      }
      prevPlace = e.place;
      prevEnd = Math.max(prevEnd, toM(e.end));
    }
    const last = stays[stays.length - 1];
    if (last && last.place !== home) {
      const r = find(last.place, home), m = r ? +r.minutes : 0, le = toM(last.end);
      if (m > 0 && !moving.some((x) => toM(x.start) >= le)) out.push(seg(`travel-home-${last.id}`, date, le, le + m, last.place, home, r.mode || ''));
    }
  }
  return out;
}

/** 予定が「あとから」のキー（予定名の一部、または場所名）に当てはまるか */
export const matchesKey = (e, key) => {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return false;
  if (e.virtual) return false; // 自動で作った移動時間は「あとから」の基準にしない
  return String(e.title || '').toLowerCase().includes(k) || String(e.place || '').toLowerCase() === k;
};

/**
 * 空き区間 [a, b] にいる場所を推定する。
 * @param placed その日の「場所つき」ユーザー予定（開始順）
 * @returns {string|null} 場所名。不明なら null
 */
export function placeOfGap(placed, a, b, s) {
  const home = s.home || '家';
  let prev = null, next = null;
  for (const e of placed) {
    if (toM(e.end) <= a) prev = e;
    else if (!next && toM(e.start) >= b) next = e;
  }
  if (!prev || !next) return home;
  const tr = (e) => isTransit(e.place, s);
  const arrive = tr(prev) ? (tr(next) ? null : next.place) : prev.place;
  const depart = tr(next) ? (tr(prev) ? null : prev.place) : next.place;
  return arrive && arrive === depart ? arrive : null;
}

/** 条件の説明（画面表示用） */
export function describe(x) {
  const out = [];
  if ((x.places || []).length) out.push(x.places.join('・') + 'で');
  if (x.notBefore) out.push(`${x.notBefore.replace(/^0/, '')}以降`);
  if (x.notAfter) out.push(`${x.notAfter.replace(/^0/, '')}まで`);
  if (x.after && x.after.key) {
    const m = +x.after.min || 0;
    out.push(`「${x.after.key}」の${m ? (m % 60 ? m + '分' : m / 60 + '時間') + '後' : '後'}から`);
  }
  return out.join(' ');
}
