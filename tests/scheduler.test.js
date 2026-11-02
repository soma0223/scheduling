import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeSlots, plan, gaps, busyIntervals, DEFAULT_SETTINGS } from '../web/js/scheduler.js';

// 2026-11-02 は月曜
const NOW = new Date(2026, 10, 2, 8, 0);
const S = { ...DEFAULT_SETTINGS };
const ev = (id, date, start, end, extra = {}) => ({ id, title: id, date, start, end, color: '#000', ...extra });

test('gaps: 区間の隙間を返す', () => {
  assert.deepEqual(gaps([[60, 120], [180, 200]], 0, 300), [[0, 60], [120, 180], [200, 300]]);
  assert.deepEqual(gaps([[0, 400]], 0, 300), []);
});

test('freeSlots: 30分未満の隙間は空き時間にしない', () => {
  const events = [ev('a', '2026-11-03', '09:00', '10:00'), ev('b', '2026-11-03', '10:20', '12:00')];
  const f = freeSlots(events, '2026-11-03', S, NOW);
  assert.deepEqual(f, [[7 * 60, 9 * 60], [12 * 60, 23 * 60]]);
});

test('freeSlots: 今日は現在時刻以降のみ', () => {
  const now = new Date(2026, 10, 2, 13, 2);
  const f = freeSlots([], '2026-11-02', S, now);
  assert.deepEqual(f, [[13 * 60 + 5, 23 * 60]]);
});

test('余白はユーザー予定にだけ付く', () => {
  const s = { ...S, bufferBefore: 15, bufferAfter: 10 };
  const events = [ev('a', '2026-11-03', '09:00', '10:00'), ev('t', '2026-11-03', '11:00', '12:00', { auto: true })];
  assert.deepEqual(busyIntervals(events, '2026-11-03', s), [[8 * 60 + 45, 10 * 60 + 10], [11 * 60, 12 * 60]]);
});

test('plan: 習慣を曜日と時間帯の中に配置', () => {
  const habits = [{ id: 'run', title: 'ランニング', days: [1, 3], from: '06:00', to: '09:00', minutes: 30 }];
  const events = [ev('m', '2026-11-04', '07:00', '07:20')];
  const r = plan({ events, todos: [], habits, settings: S }, NOW);
  const got = r.upserts.map((e) => `${e.date} ${e.start}-${e.end}`);
  // 月曜は今(8:00)以降、水曜は 7:20 の予定のあと
  assert.deepEqual(got, ['2026-11-02 08:00-08:30', '2026-11-04 07:20-07:50']);
  assert.ok(r.upserts.every((e) => e.auto && e.kind === 'habit' && e.ref === 'run'));
});

test('plan: ToDo は期限・優先度順に、入りきらなければ分割', () => {
  const s = { ...S, dayStart: '09:00', dayEnd: '12:00', horizon: 2 };
  const events = [ev('x', '2026-11-02', '10:00', '11:00')];
  const todos = [
    { id: 'a', title: 'A', minutes: 90, priority: 2 },
    { id: 'b', title: 'B', minutes: 60, priority: 2, due: '2026-11-02' },
  ];
  const r = plan({ events, todos, habits: [], settings: s }, NOW);
  const by = (id) => r.upserts.filter((e) => e.ref === id).map((e) => `${e.date} ${e.start}-${e.end}`);
  assert.deepEqual(by('b'), ['2026-11-02 09:00-10:00']);
  // A: 11/2 は 11:00-12:00 しか空かないので、丸ごと入る 11/3 9:00 を優先
  assert.deepEqual(by('a'), ['2026-11-03 09:00-10:30']);
});

test('plan: どこにも丸ごと入らない ToDo は分割、それでも足りなければ未配置', () => {
  const s = { ...S, dayStart: '09:00', dayEnd: '10:00', horizon: 2 };
  const todos = [{ id: 'big', title: 'Big', minutes: 150 }];
  const r = plan({ events: [], todos, habits: [], settings: s }, NOW);
  assert.equal(r.upserts.length, 2);
  assert.deepEqual(r.unplaced.todos, [{ id: 'big', minutes: 30 }]);
});

test('plan: 同じ入力なら2回目は変更なし（冪等）', () => {
  const todos = [{ id: 'a', title: 'A', minutes: 45 }];
  const habits = [{ id: 'h', title: 'H', days: [0, 1, 2, 3, 4, 5, 6], from: '20:00', to: '22:00', minutes: 30 }];
  const r1 = plan({ events: [], todos, habits, settings: S }, NOW);
  const r2 = plan({ events: r1.upserts, todos, habits, settings: S }, NOW);
  assert.deepEqual(r2.upserts, []);
  assert.deepEqual(r2.removes, []);
  // 時間が進んでも、まだ始まっていないブロックは動かない
  const later = new Date(2026, 10, 2, 8, 3);
  const r3 = plan({ events: r1.upserts, todos, habits, settings: S }, later);
  assert.deepEqual(r3.upserts, []);
});

test('plan: 完了した ToDo の未来ブロックは消える／予定と衝突したら移動', () => {
  const todos = [{ id: 'a', title: 'A', minutes: 60 }];
  const r1 = plan({ events: [], todos, habits: [], settings: S }, NOW);
  const blk = r1.upserts[0];
  assert.equal(blk.start, '08:00');
  const done = plan({ events: r1.upserts, todos: [{ ...todos[0], done: true }], habits: [], settings: S }, NOW);
  assert.deepEqual(done.removes, [blk.id]);
  const clash = plan({ events: [...r1.upserts, ev('m', '2026-11-02', '08:30', '09:00')], todos, habits: [], settings: S }, NOW);
  assert.deepEqual(clash.removes, [blk.id]);
  assert.equal(clash.upserts[0].start, '09:00');
});

test('plan: pinned ブロックは動かさず、必要量から差し引く', () => {
  const todos = [{ id: 'a', title: 'A', minutes: 60 }];
  const pinned = ev('p', '2026-11-03', '15:00', '15:30', { auto: true, kind: 'todo', ref: 'a', pinned: true });
  const r = plan({ events: [pinned], todos, habits: [], settings: S }, NOW);
  assert.deepEqual(r.removes, []);
  assert.equal(r.upserts.length, 1);
  assert.equal(r.upserts[0].end, '08:30');
});

test('plan: 習慣のスキップ日は配置しない', () => {
  const habits = [{ id: 'h', title: 'H', days: [1, 2], from: '20:00', to: '22:00', minutes: 30, skip: ['2026-11-03'] }];
  const r = plan({ events: [], todos: [], habits, settings: S }, NOW);
  assert.deepEqual(r.upserts.map((e) => e.date), ['2026-11-02']);
});

test('plan: 手動の順番（order）どおりに空きへ入る', () => {
  const s = { ...S, dayStart: '09:00', dayEnd: '12:00', horizon: 1, todoOrder: 'manual' };
  const todos = [
    { id: 'a', title: 'A', minutes: 60, order: 20, due: '2026-11-02' },
    { id: 'b', title: 'B', minutes: 60, order: 10 },
  ];
  const r = plan({ events: [], todos, habits: [], settings: s }, new Date(2026, 10, 2, 8, 0));
  const at = (id) => r.upserts.find((e) => e.ref === id).start;
  assert.equal(at('b'), '09:00');
  assert.equal(at('a'), '10:00');
  // 期限順に切り替えると A(期限あり) が先
  const r2 = plan({ events: [], todos, habits: [], settings: { ...s, todoOrder: 'due' } }, new Date(2026, 10, 2, 8, 0));
  assert.equal(r2.upserts.find((e) => e.ref === 'a').start, '09:00');
});

// ---- 場所・「あとから」の条件 ----
const PLACES = [{ name: '家' }, { name: '学校' }, { name: '電車', transit: true }];
const SP = { ...S, places: PLACES, home: '家', dayStart: '07:00', dayEnd: '23:00', horizon: 1 };
const MON = new Date(2026, 10, 2, 6, 0);
const slot = (r, ref) => r.upserts.filter((e) => e.ref === ref).map((e) => `${e.start}-${e.end}`);

test('場所: 家だけのToDoは、学校の予定のあいだには入らない', () => {
  const events = [
    ev('c1', '2026-11-02', '08:00', '09:00', { place: '学校' }),
    ev('c2', '2026-11-02', '12:00', '13:00', { place: '学校' }),
  ];
  const todos = [{ id: 'h', title: '家の用事', minutes: 60, places: ['家'] }];
  const r = plan({ events, todos, habits: [], settings: SP }, MON);
  assert.deepEqual(slot(r, 'h'), ['07:00-08:00']); // 朝は家。授業のあいだ(9-12)は学校
  const r2 = plan({ events, todos: [{ id: 'g', title: '学校でできる', minutes: 60, places: ['学校'] }], habits: [], settings: SP }, MON);
  assert.deepEqual(slot(r2, 'g'), ['09:00-10:00']);
});

test('場所: 予定のあと（最後の予定より後）は家', () => {
  const events = [ev('c', '2026-11-02', '07:00', '17:00', { place: '学校' })];
  const todos = [{ id: 'h', title: 'H', minutes: 60, places: ['家'] }];
  const r = plan({ events, todos, habits: [], settings: SP }, MON);
  assert.deepEqual(slot(r, 'h'), ['17:00-18:00']);
});

test('場所: 電車でできるToDoは、電車の予定のなかに入る', () => {
  const events = [
    ev('t', '2026-11-02', '08:00', '08:40', { place: '電車' }),
    ev('c', '2026-11-02', '09:00', '15:00', { place: '学校' }),
  ];
  const todos = [{ id: 'e', title: '英単語', minutes: 30, places: ['電車'] }];
  const r = plan({ events, todos, habits: [], settings: SP }, MON);
  assert.deepEqual(slot(r, 'e'), ['08:00-08:30']);
  // 電車でできないものは電車の中に入らない
  const r2 = plan({ events, todos: [{ id: 'x', title: 'X', minutes: 30 }], habits: [], settings: SP }, MON);
  assert.ok(slot(r2, 'x')[0] !== '08:00-08:30');
});

test('あとから: ジムは学校の2時間後から。学校がない日は制限なし', () => {
  const habits = [{ id: 'gym', title: 'ジム', days: [1, 2], from: '07:00', to: '22:00', minutes: 60, after: { key: '学校', min: 120 } }];
  const events = [ev('c', '2026-11-02', '09:00', '15:00', { title: '学校' })];
  const s2 = { ...SP, horizon: 2 };
  const r = plan({ events, todos: [], habits, settings: s2 }, MON);
  const gym = r.upserts.filter((e) => e.ref === 'gym').map((e) => `${e.date} ${e.start}`);
  assert.deepEqual(gym, ['2026-11-02 17:00', '2026-11-03 07:00']);
});

test('条件つきは冪等（2回目は変更なし）', () => {
  const events = [
    ev('t', '2026-11-02', '08:00', '08:40', { place: '電車' }),
    ev('c', '2026-11-02', '09:00', '15:00', { place: '学校' }),
  ];
  const todos = [{ id: 'e', title: '英単語', minutes: 30, places: ['電車'] }, { id: 'h', title: 'H', minutes: 45, places: ['家'] }];
  const habits = [{ id: 'gym', title: 'ジム', days: [1], from: '07:00', to: '22:00', minutes: 60, after: { key: '学校', min: 120 } }];
  const r1 = plan({ events, todos, habits, settings: SP }, MON);
  const r2 = plan({ events: [...events, ...r1.upserts], todos, habits, settings: SP }, MON);
  assert.deepEqual(r2.upserts, []);
  assert.deepEqual(r2.removes, []);
});

test('優先順位: 条件つきのToDoは、条件なしより先に枠を取る', () => {
  const events = [ev('c', '2026-11-02', '07:30', '23:00', { place: '学校' })];
  const todos = [
    { id: 'any', title: '何でも', minutes: 30, order: 1 },
    { id: 'home', title: '家だけ', minutes: 30, order: 2, places: ['家'] },
  ];
  // 家の枠は 7:00-7:30 の30分だけ。条件なしが先に取ると家だけが入れなくなる
  const r = plan({ events, todos, habits: [], settings: SP }, MON);
  assert.deepEqual(slot(r, 'home'), ['07:00-07:30']);
  const r2 = plan({ events, todos, habits: [], settings: { ...SP, constrainedFirst: '0' } }, MON);
  assert.deepEqual(slot(r2, 'home'), []);
});

test('fresh: 並び順を変えると、置き済みの枠も並べ直される', () => {
  const s = { ...S, dayStart: '09:00', dayEnd: '12:00', horizon: 1 };
  const now = new Date(2026, 10, 2, 8, 0);
  const todos = [{ id: 'a', title: 'A', minutes: 60, order: 1 }, { id: 'b', title: 'B', minutes: 60, order: 2 }];
  const r1 = plan({ events: [], todos, habits: [], settings: s }, now);
  const placed = r1.upserts;
  assert.equal(placed.find((e) => e.ref === 'a').start, '09:00');
  const swapped = [{ ...todos[0], order: 2 }, { ...todos[1], order: 1 }];
  // 通常の再計算では動かない（毎分ずれない仕様）
  assert.deepEqual(plan({ events: placed, todos: swapped, habits: [], settings: s }, now).upserts, []);
  // fresh なら並び順どおりに入れ替わる
  const r = plan({ events: placed, todos: swapped, habits: [], settings: s }, now, { fresh: true });
  const at = (id) => r.upserts.find((e) => e.ref === id).start;
  assert.equal(at('b'), '09:00');
  assert.equal(at('a'), '10:00');
  // 順番が同じなら fresh でも変更なし
  assert.deepEqual(plan({ events: placed, todos, habits: [], settings: s }, now, { fresh: true }).upserts, []);
});

test('fresh: 固定した枠と開始済みの枠は動かさない', () => {
  const s = { ...S, dayStart: '09:00', dayEnd: '12:00', horizon: 1 };
  const now = new Date(2026, 10, 2, 8, 0);
  const todos = [{ id: 'a', title: 'A', minutes: 60, order: 1 }];
  const pinned = ev('p', '2026-11-02', '11:00', '12:00', { auto: true, kind: 'todo', ref: 'a', pinned: true });
  const r = plan({ events: [pinned], todos: [{ ...todos[0], minutes: 120 }], habits: [], settings: s }, now, { fresh: true });
  assert.deepEqual(r.removes, []);
  assert.equal(r.upserts.length, 1); // 残り60分ぶんだけ新しく置く
});
