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

import { toM } from './util.js';

export const DEFAULT_PLACES = [
  { name: '家', transit: false },
  { name: '学校', transit: false },
  { name: '職場', transit: false },
  { name: '電車', transit: true },
];

/** 場所または「あとから」の条件を持つか */
export const hasConstraint = (x) => !!(x && ((x.places || []).length || (x.after && x.after.key)));

export const isTransit = (name, s) => !!(s.places || []).find((p) => p.name === name)?.transit;

/** 予定が「あとから」のキー（予定名の一部、または場所名）に当てはまるか */
export const matchesKey = (e, key) => {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return false;
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
  if (x.after && x.after.key) {
    const m = +x.after.min || 0;
    out.push(`「${x.after.key}」の${m ? (m % 60 ? m + '分' : m / 60 + '時間') + '後' : '後'}から`);
  }
  return out.join(' ');
}
