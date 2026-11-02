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
