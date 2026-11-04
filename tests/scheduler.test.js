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

// ---- 活動時間が翌日にまたがる（7:00〜翌2:00）----
import { freeSlots as fs2, logicalNow, normalizeEvent, denormalizeEvent } from '../web/js/scheduler.js';
const NIGHT = { ...S, dayStart: '07:00', dayEnd: '02:00', dayEndNext: true, horizon: 2 };

test('深夜: 空き時間は 24:00 を越えて翌2:00まで続く', () => {
  const f = fs2([], '2026-11-02', NIGHT, new Date(2026, 10, 1, 12, 0));
  assert.deepEqual(f, [[7 * 60, 26 * 60]]);
});

test('深夜: 翌日0〜2時の予定は前日の夜の続きとして空きを減らす', () => {
  const events = [ev('late', '2026-11-03', '00:30', '01:30')]; // 11/3 の 0:30 = 11/2 の夜
  const f = fs2(events, '2026-11-02', NIGHT, new Date(2026, 10, 1, 12, 0));
  assert.deepEqual(f, [[7 * 60, 24 * 60 + 30], [25 * 60 + 30, 26 * 60]]);
  // 11/3 の昼側には影響しない
  assert.deepEqual(fs2(events, '2026-11-03', NIGHT, new Date(2026, 10, 1, 12, 0)), [[7 * 60, 26 * 60]]);
});

test('深夜: 午前1時は前日の論理日（now）', () => {
  assert.deepEqual(logicalNow(new Date(2026, 10, 3, 1, 0), NIGHT), { date: '2026-11-02', min: 25 * 60 });
  assert.deepEqual(logicalNow(new Date(2026, 10, 3, 3, 0), NIGHT), { date: '2026-11-03', min: 3 * 60 });
});

test('深夜: normalize/denormalize は往復で元に戻る', () => {
  const e = ev('x', '2026-11-03', '00:30', '01:00');
  const n = normalizeEvent(e, NIGHT);
  assert.deepEqual([n.date, n.start, n.end], ['2026-11-02', '24:30', '25:00']);
  assert.deepEqual(normalizeEvent(n, NIGHT), n); // 何度かけても同じ
  const back = denormalizeEvent(n);
  assert.deepEqual([back.date, back.start, back.end], ['2026-11-03', '00:30', '01:00']);
});

test('深夜: ToDo は 24:00 をまたがず、翌日の日付・時刻で保存される。再計算しても変わらない', () => {
  // 7:00〜23:00 は予定で埋めて、夜〜深夜だけ空ける
  const events = [ev('day', '2026-11-02', '07:00', '23:00')];
  const todos = [{ id: 'a', title: 'A', minutes: 180 }];
  const now = new Date(2026, 10, 2, 6, 0);
  const r = plan({ events, todos, habits: [], settings: { ...NIGHT, horizon: 1 } }, now);
  assert.ok(r.upserts.every((e) => toMin(e.end) > toMin(e.start)), '日付をまたぐ枠がある');
  const dates = r.upserts.map((e) => e.date).sort();
  assert.deepEqual(dates, ['2026-11-02', '2026-11-03']);
  const r2 = plan({ events: [...events, ...r.upserts], todos, habits: [], settings: { ...NIGHT, horizon: 1 } }, now);
  assert.deepEqual(r2.upserts, []);
  assert.deepEqual(r2.removes, []);
});
const toMin = (t) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };

test('深夜: 習慣を 0:00〜2:00 の時間帯に置ける（前日の夜扱い）', () => {
  const habits = [{ id: 'h', title: '夜ふかし読書', days: [1], from: '00:00', to: '02:00', minutes: 30 }];
  const r = plan({ events: [], todos: [], habits, settings: { ...NIGHT, horizon: 1 } }, new Date(2026, 10, 2, 6, 0));
  // 月曜(11/2)の夜 = 11/3 0:00
  assert.deepEqual(r.upserts.map((e) => `${e.date} ${e.start}`), ['2026-11-03 00:00']);
});

test('活動時間: 保存されたフラグと食い違っても、終了が開始以前なら翌日として扱う', () => {
  const now = new Date(2026, 10, 2, 20, 53);
  const todos = [{ id: 'a', title: 'A', minutes: 60 }];
  const r = plan({ events: [], todos, habits: [], settings: { ...S, dayEnd: '02:59', dayEndNext: false, horizon: 1 } }, now);
  assert.deepEqual(r.upserts.map((e) => `${e.date} ${e.start}`), ['2026-11-02 20:55']);
});

// ---- 移動（ルート・手段）----
import { travelSegments } from '../web/js/constraints.js';
const TS = { ...DEFAULT_SETTINGS, home: '家', places: [{ name: '家' }, { name: '学校' }, { name: 'ジム' }],
  modes: [{ name: '徒歩', work: false }, { name: '電車', work: true }],
  routes: [{ from: '家', to: '学校', minutes: 40, mode: '電車' }, { from: '学校', to: 'ジム', minutes: 15, mode: '徒歩' }],
  dayStart: '07:00', dayEnd: '23:00', horizon: 1 };
const SCH = ev('s', '2026-11-02', '09:00', '15:00', { place: '学校', title: '授業' });
const tmin = (x) => `${x.start}-${x.end}`;

test('移動: 場所が変わる予定の前後に移動時間ができる（行き・帰り）', () => {
  const t = travelSegments([SCH], TS);
  assert.deepEqual(t.map((x) => [x.id, tmin(x), x.place]), [['travel-s', '08:20-09:00', '電車'], ['travel-home-s', '15:00-15:40', '電車']]);
});

test('移動: 学校→ジムのように場所が変わる予定のあいだにも入る。同じ場所なら入らない', () => {
  const gym = ev('g', '2026-11-02', '16:00', '17:00', { place: 'ジム' });
  const t = travelSegments([SCH, gym], TS);
  assert.deepEqual(t.map((x) => `${x.id} ${tmin(x)}`), ['travel-s 08:20-09:00', 'travel-g 15:45-16:00']); // ジム→家のルートは未登録なので帰りは無し
  // 同じ場所どうし（学校→学校）の間には作らない
  const school2 = ev('s2', '2026-11-02', '10:00', '11:00', { place: '学校' });
  assert.equal(travelSegments([{ ...SCH, end: '09:50' }, school2], TS).filter((x) => x.id === 'travel-s2').length, 0);
});

test('移動: 予定ごとの上書き（移動なし／別の手段と時間）', () => {
  assert.deepEqual(travelSegments([{ ...SCH, travel: { mode: '', minutes: 0 } }], TS).map((x) => x.id), ['travel-home-s']);
  const t = travelSegments([{ ...SCH, travel: { mode: '徒歩', minutes: 20 } }], TS).find((x) => x.id === 'travel-s');
  assert.deepEqual([tmin(t), t.place], ['08:40-09:00', '徒歩']);
});

test('移動: 自分で「電車」の予定を入れているときは自動で作らない', () => {
  const train = ev('t', '2026-11-02', '08:00', '08:40', { place: '電車' });
  assert.deepEqual(travelSegments([train, SCH], TS).filter((x) => x.id === 'travel-s'), []);
});

test('移動: 空き時間・ToDo配置は移動時間を避ける。電車でできるToDoは電車の移動中に入る', () => {
  const now = new Date(2026, 10, 2, 6, 0);
  const f = fs2([SCH], '2026-11-02', TS, now);
  assert.deepEqual(f, [[7 * 60, 8 * 60 + 20], [15 * 60 + 40, 23 * 60]]);
  const todos = [{ id: 'e', title: '英単語', minutes: 30, places: ['電車'] }, { id: 'a', title: '何でも', minutes: 30 }];
  const r = plan({ events: [SCH], todos, habits: [], settings: TS }, now);
  assert.deepEqual(slot(r, 'e'), ['08:20-08:50']); // 電車でできる → 電車の移動中
  assert.deepEqual(slot(r, 'a'), ['07:00-07:30']); // 何でも → 移動時間は避けて朝の空きへ
  // 冪等
  const r2 = plan({ events: [SCH, ...r.upserts], todos, habits: [], settings: TS }, now);
  assert.deepEqual(r2.upserts, []);
  assert.deepEqual(r2.removes, []);
});

// ---- 時間帯を決めない習慣 ----
test('習慣(anytime): 活動時間のどこでも。ちょうど収まる隙間を選び、大きな空きを残す', () => {
  const s = { ...S, dayStart: '08:00', dayEnd: '20:00', horizon: 1 };
  const now = new Date(2026, 10, 2, 6, 0);
  // 空き: 08:00-12:00(4h) / 12:30-13:30(1h) / 14:00-20:00(6h)
  const events = [ev('a', '2026-11-02', '12:00', '12:30'), ev('b', '2026-11-02', '13:30', '14:00')];
  const habits = [{ id: 'h', title: '読書', days: [1], minutes: 45, anytime: true }];
  const r = plan({ events, todos: [], habits, settings: s }, now);
  assert.deepEqual(r.upserts.map((e) => `${e.start}-${e.end}`), ['12:30-13:15']);
  // 冪等
  assert.deepEqual(plan({ events: [...events, ...r.upserts], todos: [], habits, settings: s }, now).upserts, []);
  // 時間帯を決めた習慣は従来どおり最初に入る空き
  const w = plan({ events, todos: [], habits: [{ ...habits[0], anytime: false, from: '08:00', to: '20:00' }], settings: s }, now);
  assert.deepEqual(w.upserts.map((e) => e.start), ['08:00']);
});

test('習慣(anytime): ToDo は習慣が残した大きな空きに入る', () => {
  const s = { ...S, dayStart: '08:00', dayEnd: '20:00', horizon: 1 };
  const now = new Date(2026, 10, 2, 6, 0);
  const events = [ev('a', '2026-11-02', '12:00', '12:30'), ev('b', '2026-11-02', '13:30', '14:00')];
  const habits = [{ id: 'h', title: '読書', days: [1], minutes: 45, anytime: true }];
  const todos = [{ id: 't', title: 'T', minutes: 180 }];
  const r = plan({ events, todos, habits, settings: s }, now);
  assert.deepEqual(r.upserts.filter((e) => e.ref === 't').map((e) => e.start), ['08:00']);
  assert.deepEqual(r.unplaced.todos, []);
});

// ---- 週◯回 / 何時以降・何時まで ----
const WK = { ...S, dayStart: '08:00', dayEnd: '22:00', horizon: 7 };
const MON6 = new Date(2026, 10, 2, 6, 0); // 月曜の朝
const dates = (r, ref) => r.upserts.filter((e) => e.ref === ref).map((e) => e.date).sort();

test('週N回: 曜日は自由で、間があくように選ぶ（週3回 → 月・水・金）', () => {
  const habits = [{ id: 'h', title: '運動', days: [0, 1, 2, 3, 4, 5, 6], minutes: 30, anytime: true, perWeek: 3 }];
  const r = plan({ events: [], todos: [], habits, settings: WK }, MON6);
  assert.deepEqual(dates(r, 'h'), ['2026-11-02', '2026-11-04', '2026-11-06']);
  // 冪等
  assert.deepEqual(plan({ events: r.upserts, todos: [], habits, settings: WK }, MON6).upserts, []);
});

test('週N回: すでにこなした分を数える／使える曜日で絞る／予定で埋まった日は避ける', () => {
  const now = new Date(2026, 10, 4, 6, 0); // 水曜
  const habits = [{ id: 'h', title: '運動', days: [1, 3, 5, 6], minutes: 30, anytime: true, perWeek: 2 }];
  // 月曜に1回こなし済み
  const done = ev('old', '2026-11-02', '08:00', '08:30', { auto: true, kind: 'habit', ref: 'h' });
  const r = plan({ events: [done], todos: [], habits, settings: { ...WK, horizon: 4 } }, now); // 水〜土
  assert.deepEqual(dates(r, 'h'), ['2026-11-06']); // 月曜に1回こなし済み → 残り1回は、間があく金曜
  // 金曜が終日埋まっていれば、次に間のあく土曜へ
  const busy = [done, ev('b', '2026-11-06', '08:00', '22:00')];
  const r2 = plan({ events: busy, todos: [], habits, settings: { ...WK, horizon: 4 } }, now);
  assert.deepEqual(dates(r2, 'h'), ['2026-11-07']);
});

test('週N回: 回数を減らすと先の日の枠から外れる／回数が足りないと警告', () => {
  const habits3 = [{ id: 'h', title: '運動', days: [0, 1, 2, 3, 4, 5, 6], minutes: 30, anytime: true, perWeek: 3 }];
  const r = plan({ events: [], todos: [], habits: habits3, settings: WK }, MON6);
  const r2 = plan({ events: r.upserts, todos: [], habits: [{ ...habits3[0], perWeek: 2 }], settings: WK }, MON6);
  assert.deepEqual(r2.removes.length, 1);
  assert.equal(r2.removes[0].includes('2026-11-06'), true);
  // 使える日が1日しかないのに週3回 → 置けた分だけ置いて警告
  const r3 = plan({ events: [], todos: [], habits: [{ ...habits3[0], days: [1] }], settings: { ...WK, horizon: 7 } }, MON6);
  assert.deepEqual(dates(r3, 'h'), ['2026-11-02']);
  assert.equal(r3.unplaced.habits.length, 2);
});

test('何時以降・何時まで: ToDo も習慣も、その範囲の空きにだけ入る', () => {
  const s = { ...WK, horizon: 1 };
  const todos = [{ id: 't', title: 'T', minutes: 60, notBefore: '19:00' }, { id: 'u', title: 'U', minutes: 60, notAfter: '10:00' }];
  const r = plan({ events: [], todos, habits: [], settings: s }, MON6);
  assert.deepEqual(slot(r, 't'), ['19:00-20:00']);
  assert.deepEqual(slot(r, 'u'), ['08:00-09:00']);
  // 範囲に収まらなければ置かない（○○時以降なのに夜は予定で埋まっている）
  const busyNight = [ev('n', '2026-11-02', '19:00', '22:00')];
  const r2 = plan({ events: busyNight, todos: [todos[0]], habits: [], settings: s }, MON6);
  assert.deepEqual(r2.unplaced.todos, [{ id: 't', minutes: 60 }]);
  const h = plan({ events: [], todos: [], habits: [{ id: 'h', title: 'H', days: [1], anytime: true, minutes: 30, notBefore: '21:00' }], settings: s }, MON6);
  assert.deepEqual(h.upserts.map((e) => e.start), ['21:00']);
});

test('何時以降: 深夜まで続く活動時間では 0:30 以降が翌日側として扱われる。冪等', () => {
  const s = { ...NIGHT, horizon: 1 };
  const todos = [{ id: 't', title: 'T', minutes: 30, notBefore: '00:30' }];
  const now = new Date(2026, 10, 2, 6, 0);
  const r = plan({ events: [], todos, habits: [], settings: s }, now);
  assert.deepEqual(r.upserts.map((e) => `${e.date} ${e.start}`), ['2026-11-03 00:30']);
  assert.deepEqual(plan({ events: r.upserts, todos, habits: [], settings: s }, now).upserts, []);
});

// ---- 曜日の繰り返し予定 ----
import { expandEvents, nextMatching, isRecurring } from '../web/js/recurrence.js';
const CLASS = ev('cls', '2026-11-02', '09:00', '15:00', { title: '授業', place: '学校', repeat: { days: [1, 2, 3, 4, 5], until: '' }, skip: ['2026-11-04'] });

test('繰り返し: 曜日の回に展開／スキップ日・期限・開始日前は出ない', () => {
  const out = expandEvents([CLASS], '2026-11-01', '2026-11-09');
  assert.deepEqual(out.map((e) => e.date), ['2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06', '2026-11-09']); // 水(4)はスキップ、土日なし
  assert.equal(out[0].id, 'cls@2026-11-02');
  assert.equal(out[0].series, 'cls');
  assert.deepEqual(expandEvents([{ ...CLASS, repeat: { days: [1], until: '2026-11-03' } }], '2026-10-26', '2026-11-30').map((e) => e.date), ['2026-11-02']);
  // 展開済みのものをもう一度通しても増えない／削除済みの親は出ない
  assert.equal(expandEvents(out, '2026-11-01', '2026-11-09').length, out.length);
  assert.equal(isRecurring({ ...CLASS, deleted: true }), true);
  assert.deepEqual(expandEvents([{ ...CLASS, deleted: true }], '2026-11-01', '2026-11-09').filter((e) => !e.deleted), []);
  assert.equal(nextMatching('2026-11-07', [1, 3]), '2026-11-09'); // 土 → 次の月
});

test('繰り返し: 空き時間・ToDo 配置・移動時間・「あとから」に効く。冪等', () => {
  const now = new Date(2026, 10, 3, 6, 0); // 火曜
  const f = fs2([CLASS], '2026-11-03', S, now); // 親だけ渡しても展開される
  assert.deepEqual(f, [[7 * 60, 9 * 60], [15 * 60, 23 * 60]]);
  // 水曜はスキップ → 終日空き
  assert.deepEqual(fs2([CLASS], '2026-11-04', S, now), [[7 * 60, 23 * 60]]);
  // 土曜は繰り返し対象外
  assert.deepEqual(fs2([CLASS], '2026-11-07', S, now), [[7 * 60, 23 * 60]]);
  const habits = [{ id: 'gym', title: 'ジム', days: [2], from: '07:00', to: '22:00', minutes: 60, after: { key: '授業', min: 120 } }];
  const todos = [{ id: 't', title: 'T', minutes: 60 }];
  const r = plan({ events: [CLASS], todos, habits, settings: { ...S, horizon: 2 } }, now);
  assert.deepEqual(r.upserts.filter((e) => e.ref === 'gym').map((e) => `${e.date} ${e.start}`), ['2026-11-03 17:00']); // 授業の終了(15:00)+2時間
  assert.ok(r.upserts.every((e) => !(e.date === '2026-11-03' && e.start < '15:00' && e.end > '09:00')), '授業の時間に配置された');
  const r2 = plan({ events: [CLASS, ...r.upserts], todos, habits, settings: { ...S, horizon: 2 } }, now);
  assert.deepEqual(r2.upserts, []);
  assert.deepEqual(r2.removes, []);
});

// ---- 帰宅の所要時間 ----
const TH = { ...TS, routes: [{ from: '家', to: '学校', minutes: 40, mode: '電車', backMinutes: 55, backMode: 'バス' }], modes: [{ name: '徒歩', work: false }, { name: '電車', work: true }, { name: 'バス', work: true }] };

test('帰宅: 行きと帰りで時間・手段を変えられる', () => {
  const t = travelSegments([SCH], TH);
  assert.deepEqual(t.map((x) => [x.id, tmin(x), x.place]), [['travel-s', '08:20-09:00', '電車'], ['travel-home-s', '15:00-15:55', 'バス']]);
  // 帰りの欄を空にすると行きと同じ
  const same = travelSegments([SCH], { ...TH, routes: [{ from: '家', to: '学校', minutes: 40, mode: '電車' }] });
  assert.deepEqual(same.map((x) => tmin(x)), ['08:20-09:00', '15:00-15:40']);
});

test('帰宅: 予定ごとの指定（別の手段・時間／帰宅の移動なし／ルートが無くても）', () => {
  const back = (e, s = TH) => travelSegments([e], s).find((x) => x.id === 'travel-home-s');
  const t = back({ ...SCH, travelAfter: { mode: '徒歩', minutes: 25 } });
  assert.deepEqual([tmin(t), t.place], ['15:00-15:25', '徒歩']);
  assert.equal(back({ ...SCH, travelAfter: { mode: '', minutes: 0 } }), undefined);
  // 手段だけ変える（時間は帰りのルートどおり）
  const m = back({ ...SCH, travelAfter: { mode: '徒歩', minutes: null } });
  assert.deepEqual([tmin(m), m.place], ['15:00-15:55', '徒歩']);
  // ルートが未登録でも、その予定に時間を指定すれば帰宅の移動ができる
  const none = back({ ...SCH, travelAfter: { mode: '徒歩', minutes: 20 } }, { ...TH, routes: [] });
  assert.deepEqual(tmin(none), '15:00-15:20');
});

test('帰宅: 帰宅の移動が終わってから家のToDoが入る。冪等', () => {
  const now = new Date(2026, 10, 2, 6, 0);
  const todos = [{ id: 'h', title: '家の用事', minutes: 30, places: ['家'], notBefore: '15:00' }];
  const e = { ...SCH, travelAfter: { mode: '徒歩', minutes: 25 } };
  const r = plan({ events: [e], todos, habits: [], settings: TH }, now);
  assert.deepEqual(slot(r, 'h'), ['15:25-15:55']);
  assert.deepEqual(plan({ events: [e, ...r.upserts], todos, habits: [], settings: TH }, now).upserts, []);
});

// ---- 隔週・いつまで・何回 ----
test('繰り返し: 隔週（親の日付の週を基準に、2週おき）', () => {
  const m = ev('b', '2026-11-02', '10:00', '11:00', { repeat: { days: [1, 3], every: 2 } }); // 月・水を隔週
  assert.deepEqual(expandEvents([m], '2026-11-01', '2026-11-30').map((e) => e.date),
    ['2026-11-02', '2026-11-04', '2026-11-16', '2026-11-18', '2026-11-30']);
  // 開始日が週の途中でも、その週が基準（11/4 水 → 11/4, 11/16, 11/18…）
  const m2 = { ...m, date: '2026-11-04' };
  assert.deepEqual(expandEvents([m2], '2026-11-01', '2026-11-20').map((e) => e.date), ['2026-11-04', '2026-11-16', '2026-11-18']);
});

test('繰り返し: 回数で終わる／日付で終わる／早いほうが優先／スキップした回も回数に数える', () => {
  const base = ev('c', '2026-11-02', '10:00', '11:00');
  const dates = (rep, extra = {}) => expandEvents([{ ...base, repeat: rep, ...extra }], '2026-10-01', '2027-03-01').map((e) => e.date);
  assert.deepEqual(dates({ days: [1, 3], count: 3 }), ['2026-11-02', '2026-11-04', '2026-11-09']);
  assert.deepEqual(dates({ days: [1], every: 2, count: 3 }), ['2026-11-02', '2026-11-16', '2026-11-30']);
  assert.deepEqual(dates({ days: [1, 3], until: '2026-11-05' }), ['2026-11-02', '2026-11-04']);
  assert.deepEqual(dates({ days: [1, 3], until: '2026-12-31', count: 2 }), ['2026-11-02', '2026-11-04']); // 回数のほうが早い
  assert.deepEqual(dates({ days: [1, 3], count: 3 }, { skip: ['2026-11-04'] }), ['2026-11-02', '2026-11-09']); // 11/4 は消したが3回目は 11/9 のまま
  // 見ている期間が先でも、回数は親の日付から数える
  assert.deepEqual(expandEvents([{ ...base, repeat: { days: [1], count: 2 } }], '2026-11-09', '2026-12-31').map((e) => e.date), ['2026-11-09']);
});

test('繰り返し: 隔週の予定は、空きの計算にも隔週で効く', () => {
  const m = ev('b', '2026-11-02', '10:00', '11:00', { repeat: { days: [1], every: 2 } });
  const now = new Date(2026, 10, 1, 6, 0);
  assert.deepEqual(fs2([m], '2026-11-09', S, now), [[7 * 60, 23 * 60]]); // 隔週なので 11/9 は無し
  assert.deepEqual(fs2([m], '2026-11-16', S, now), [[7 * 60, 10 * 60], [11 * 60, 23 * 60]]);
});

// ---- くり返しの ToDo（水曜に出た課題を木曜までに）----
import { repeatTodoInstances, occurrenceDates } from '../web/js/recurrence.js';
const TPL = { id: 'kd', title: '課題', minutes: 90, template: true, date: '2026-11-04', repeat: { days: [3], dueAfter: 1 }, priority: 2 }; // 毎週水曜 → 翌日(木)まで

test('くり返しToDo: 出た回ごとに ToDo を作る（出た日・期限つき）。期限が過ぎた回は作らない', () => {
  const ids = (today, last) => repeatTodoInstances(TPL, today, last).map((t) => `${t.id} ${t.start}→${t.due}`);
  assert.deepEqual(ids('2026-11-02', '2026-11-16'), ['kd@2026-11-04 2026-11-04→2026-11-05', 'kd@2026-11-11 2026-11-11→2026-11-12']);
  // 木曜に開いても、水曜に出た課題（期限は今日）は入る。金曜なら期限切れなので作らない
  assert.deepEqual(ids('2026-11-05', '2026-11-08'), ['kd@2026-11-04 2026-11-04→2026-11-05']);
  assert.deepEqual(ids('2026-11-06', '2026-11-08'), []);
  assert.deepEqual(occurrenceDates({ ...TPL, repeat: { days: [3], every: 2 } }, '2026-11-01', '2026-12-01'), ['2026-11-04', '2026-11-18']);
  assert.deepEqual(repeatTodoInstances({ ...TPL, template: false }, '2026-11-02', '2026-11-16'), []);
});

test('くり返しToDo: 出た日〜期限のあいだの空きにだけ入る。雛形そのものは配置しない', () => {
  const s = { ...S, dayStart: '09:00', dayEnd: '12:00', horizon: 7 };
  const now = new Date(2026, 10, 2, 6, 0); // 月曜
  const [inst] = repeatTodoInstances(TPL, '2026-11-02', '2026-11-08');
  // 水曜(11/4)の空きを予定で埋める → 木曜(11/5)に入る。月・火には入らない
  const events = [ev('b', '2026-11-04', '09:00', '12:00')];
  const r = plan({ events, todos: [TPL, inst], habits: [], settings: s }, now);
  const t = r.upserts.filter((e) => e.kind === 'todo');
  assert.deepEqual(t.map((e) => e.ref), ['kd@2026-11-04']);
  assert.deepEqual(t.map((e) => `${e.date} ${e.start}-${e.end}`), ['2026-11-05 09:00-10:30']);
  // 冪等
  assert.deepEqual(plan({ events: [...events, ...r.upserts], todos: [TPL, inst], habits: [], settings: s }, now).upserts, []);
  // 水・木ともに埋まっていて期限内に入らないときは、期限のあとの空きに入れる（これまでの動き）
  const full = [...events, ev('c', '2026-11-05', '09:00', '12:00')];
  const r2 = plan({ events: full, todos: [inst], habits: [], settings: s }, now);
  assert.deepEqual(r2.upserts.map((e) => e.date), ['2026-11-06']);
  // まだ出ていない回（出る日が配置期間の先）は置かない・警告も出さない
  const future = { ...inst, id: 'kd@2026-12-02', start: '2026-12-02', due: '2026-12-03' };
  const r3 = plan({ events: [], todos: [future], habits: [], settings: s }, now);
  assert.deepEqual([r3.upserts, r3.unplaced.todos], [[], []]);
});
