import * as store from './store.js';
import * as sync from './sync.js';
import * as push from './push.js';
import * as ai from './ai.js';
import { plan, freeSlots, freeTotal, todoCompare, HABIT_COLOR } from './scheduler.js';
import { hasConstraint, describe } from './constraints.js';
import { WD, toM, fm, dur, ymd, pd, addDays, minutesOf, label, uid } from './util.js';

const COLORS = ['#2f6fed', '#e0573d', '#2e9e6b', '#d49a1a', '#8b5cf6'];
const H = 52; // 1時間の高さ(px)
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const el = (tag, cls, txt) => { const x = document.createElement(tag); if (cls) x.className = cls; if (txt !== undefined) x.textContent = txt; return x; };

const qs = new URLSearchParams(location.search);
let sel = /^\d{4}-\d{2}-\d{2}$/.test(qs.get('date') || '') ? qs.get('date') : ymd(new Date());
let tab = ['day', 'todo', 'habit', 'settings'].includes(qs.get('tab')) ? qs.get('tab') : 'day';
let unplaced = { todos: [], habits: [] };
const estimating = new Set();
let sheetOpen = false;

const S = () => store.settings();
const events = () => store.all('event');

// ---------------------------------------------------------------- テーマ
function applyTheme() {
  const t = S().theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---------------------------------------------------------------- 自動配置
let replanTimer = null;
function replan(now = new Date()) {
  const r = plan({ events: store.raw('event'), todos: store.raw('todo'), habits: store.raw('habit'), settings: S() }, now);
  unplaced = r.unplaced;
  if (r.upserts.length || r.removes.length) {
    store.batch(({ put, remove }) => {
      r.upserts.forEach((e) => put('event', e));
      r.removes.forEach((id) => remove('event', id));
    });
    return true;
  }
  return false;
}
const scheduleReplan = () => { clearTimeout(replanTimer); replanTimer = setTimeout(() => { if (!replan()) render(); }, 50); };

// ---------------------------------------------------------------- 画面切り替え
function setTab(t) {
  tab = t;
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'v-' + t));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $('#fab').hidden = t === 'settings';
  const u = new URL(location.href);
  u.searchParams.set('tab', t);
  history.replaceState(null, '', u);
  render();
  scrollTo(0, 0);
}

function render() {
  if (tab === 'day') renderDay();
  else if (tab === 'todo') renderTodos();
  else if (tab === 'habit') renderHabits();
  else renderSettings();
}

// ---------------------------------------------------------------- 1日ビュー
function renderDay() {
  const now = new Date(), today = ymd(now), isToday = sel === today, s = S();
  const sd = pd(sel);
  $('#ttl').textContent = `${sd.getMonth() + 1}月${sd.getDate()}日（${WD[sd.getDay()]}）`;
  $('#jump').value = sel;

  // 週ストリップ（日曜はじまり）
  const all = events();
  const w0 = addDays(sel, -sd.getDay());
  let wh = '';
  for (let i = 0; i < 7; i++) {
    const k = addDays(w0, i), d = pd(k);
    const dots = all.filter((e) => e.date === k).slice(0, 4).map((e) => `<i class="dot" style="background:${esc(e.color)}"></i>`).join('');
    const ft = k >= today ? freeTotal(all, k, s, now) : 0;
    wh += `<button class="wk ${i == 0 ? 'sun' : i == 6 ? 'sat' : ''} ${k == today ? 'today' : ''} ${k == sel ? 'sel' : ''}" data-d="${k}">${WD[i]}<b>${d.getDate()}</b><span class="dots">${dots}</span><span class="fr">${ft ? Math.round(ft / 30) / 2 + 'h' : ''}</span></button>`;
  }
  $('#week').innerHTML = wh;

  const items = all.filter((e) => e.date === sel).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const timed = items.filter((e) => e.start), plain = items.filter((e) => !e.start);

  // サマリー
  const fr = sel < today ? [] : freeSlots(all, sel, s, now);
  const sum = $('#sum');
  sum.innerHTML = '';
  const tot = fr.reduce((a, [x, y]) => a + y - x, 0);
  const big = el('div', 'big');
  big.append(isToday ? 'この先の空き時間 ' : '空き時間 ', el('b', 0, tot ? dur(tot) : 'なし'));
  sum.append(big);
  sum.append(el('div', 'sub', `活動時間 ${s.dayStart}–${s.dayEnd}・${s.minFree}分以上の隙間を表示`));
  const ch = el('div', 'chips');
  fr.forEach(([a, b]) => {
    const c = el('button', 'chip', `${fm(a)}–${fm(b)}（${dur(b - a)}）`);
    c.onclick = () => openEvent(null, a, Math.min(b, a + 60));
    ch.append(c);
  });
  plain.forEach((e) => { const c = el('button', 'ad', e.title); c.onclick = () => openEvent(e.id); ch.append(c); });
  if (ch.children.length) sum.append(ch);
  const uh = unplaced.habits.filter((x) => x.date === sel);
  if (uh.length) sum.append(el('div', 'warn', '⚠ 入りきらない習慣: ' + uh.map((x) => store.get('habit', x.id)?.title).filter(Boolean).join('、')));

  // タイムライン
  const ds = toM(s.dayStart), de = toM(s.dayEnd);
  const hs = Math.max(0, Math.min(Math.floor(ds / 60) - 1, ...timed.map((e) => Math.floor(toM(e.start) / 60))));
  const he = 24;
  const tl = $('#tl');
  tl.innerHTML = '';
  tl.style.height = (he - hs) * H + 'px';
  const Y = (m) => ((m - hs * 60) * H) / 60;
  for (let h = hs; h < he; h++) {
    const l = el('div', 'hl');
    l.style.top = (h - hs) * H + 'px';
    l.append(el('span', 0, h + ':00'));
    tl.append(l);
  }
  // 活動時間外を薄く
  const shade = (a, b) => { if (b <= a) return; const o = el('div', 'off'); o.style.top = Y(a) + 'px'; o.style.height = ((b - a) * H) / 60 + 'px'; tl.append(o); };
  shade(hs * 60, ds); shade(de, 24 * 60);
  // 余白
  if (+s.bufferBefore || +s.bufferAfter) {
    timed.filter((e) => !e.auto).forEach((e) => {
      const add = (a, b) => { const x = el('div', 'buf'); x.style.top = Y(a) + 'px'; x.style.height = ((b - a) * H) / 60 + 'px'; tl.append(x); };
      if (+s.bufferBefore) add(toM(e.start) - s.bufferBefore, toM(e.start));
      if (+s.bufferAfter) add(toM(e.end), toM(e.end) + +s.bufferAfter);
    });
  }
  fr.forEach(([a, b]) => {
    const f = el('button', 'free', '空き ' + dur(b - a) + '　＋');
    f.style.top = Y(a) + 'px';
    f.style.height = Math.max(20, ((b - a) * H) / 60) + 'px';
    f.onclick = () => openEvent(null, a, Math.min(b, a + 60));
    tl.append(f);
  });
  // 重なりレイアウト
  const L = timed.map((e) => ({ e, s: toM(e.start), f: toM(e.end), c: 0, n: 1 }));
  let grp = [], gend = 0;
  const flush = () => { const n = Math.max(0, ...grp.map((x) => x.c)) + 1; grp.forEach((x) => (x.n = n)); grp = []; };
  L.forEach((x) => {
    if (grp.length && x.s >= gend) flush();
    const used = grp.filter((y) => y.f > x.s).map((y) => y.c);
    let c = 0; while (used.includes(c)) c++;
    x.c = c; grp.push(x); gend = Math.max(gend, x.f);
  });
  flush();
  const nm = minutesOf(now);
  L.forEach((x) => {
    const e = x.e, d = el('button', 'blk' + (e.auto ? ' auto' : ''));
    if (sel < today || (isToday && x.f <= nm)) d.classList.add('past');
    d.style.top = Y(x.s) + 'px';
    d.style.height = Math.max(22, ((x.f - x.s) * H) / 60 - 2) + 'px';
    d.style.left = `calc(${(x.c * 100) / x.n}% + 2px)`;
    d.style.width = `calc(${100 / x.n}% - 4px)`;
    d.style.background = e.color + '30';
    d.style.borderColor = e.color;
    const t = el('div');
    if (e.auto) t.append(el('span', 'tag', e.kind === 'todo' ? (store.get('todo', e.ref)?.done ? '✓ToDo' : 'ToDo') : '習慣'));
    t.append(e.title);
    d.append(t, el('small', 0, `${e.start}–${e.end}${e.place ? '・' + e.place : ''}${e.pinned ? '・固定' : ''}`));
    d.onclick = () => openEvent(e.id);
    tl.append(d);
  });
  if (isToday && nm >= hs * 60) { const l = el('div', 'now'); l.style.top = Y(nm) + 'px'; tl.append(l); }
}

// ---------------------------------------------------------------- シート共通
function openSheet(html, bind) {
  const p = $('#panel');
  p.innerHTML = html;
  $('#sheet').classList.add('on');
  sheetOpen = true;
  bind(p);
  const first = p.querySelector('input[type=text]');
  if (first && !first.value) setTimeout(() => first.focus(), 50);
}
function closeSheet() { $('#sheet').classList.remove('on'); sheetOpen = false; render(); }
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen) closeSheet(); });

const colorPicker = (cur, extra = []) =>
  `<div class="cols">${[...new Set([...COLORS, ...extra])].map((c) => `<label><input type="radio" name="c" value="${c}" ${c === cur ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div>`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2400);
}

// ---------------------------------------------------------------- 条件（場所・「あとから」）
const placeNames = () => (S().places || []).map((p) => p.name);

function constraintFields(cur) {
  const names = placeNames();
  const sel = new Set(cur.places || []);
  const titles = [...new Set(events().filter((e) => !e.auto && e.title).map((e) => e.title))].slice(0, 30);
  const hours = cur.after?.min ? +(cur.after.min / 60).toFixed(2) : '';
  return `<label>できる場所（選ばなければ、どこでも）</label>
    <div class="toggles" id="c-places">${names.map((n) => `<button type="button" class="tg ${sel.has(n) ? 'on' : ''}" data-p="${esc(n)}">${esc(n)}</button>`).join('')}</div>
    <label>この予定のあとから（例：「学校」の 2 時間後から）</label>
    <div class="row"><div><input type="text" id="c-key" list="c-keys" placeholder="例：学校" value="${esc(cur.after?.key)}"></div>
      <div><input type="number" id="c-hours" min="0" max="12" step="0.5" placeholder="何時間後" value="${hours}"></div></div>
    <datalist id="c-keys">${[...names, ...titles].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <p class="note">その日にその予定があるときだけ有効です。無い日は制限なし。</p>`;
}

function bindConstraints(p, cur) {
  const set = new Set(cur.places || []);
  p.querySelectorAll('#c-places .tg').forEach((b) => (b.onclick = () => {
    const n = b.dataset.p;
    set.has(n) ? set.delete(n) : set.add(n);
    b.classList.toggle('on', set.has(n));
  }));
  return () => {
    const key = $('#c-key', p).value.trim();
    const h = parseFloat($('#c-hours', p).value);
    return { places: [...set], after: key ? { key, min: Math.max(0, Math.round((Number.isFinite(h) ? h : 0) * 60)) } : null };
  };
}

// ---------------------------------------------------------------- 予定シート
function openEvent(id, s, e) {
  const x = id ? store.get('event', id) : null;
  const src = x?.auto ? store.get(x.kind, x.ref) : null;
  const head = x?.auto
    ? `<h3>${x.kind === 'todo' ? 'ToDo の作業枠' : '習慣'}：${esc(x.title)}</h3><p class="note">自動で配置された枠です。時間を変えると「固定」になり、再配置で動かなくなります。</p>`
    : `<h3>${x ? '予定を編集' : '予定を追加'}</h3>`;
  const autoActs = x?.auto
    ? (x.kind === 'todo'
      ? `<div class="acts"><button type="button" class="ok" id="f-done">${src?.done ? '未完了に戻す' : '✓ ToDo を完了'}</button>${x.pinned ? '<button type="button" id="f-unpin">固定を解除</button>' : ''}</div>`
      : `<div class="acts"><button type="button" id="f-skip">この日はスキップ</button>${x.pinned ? '<button type="button" id="f-unpin">固定を解除</button>' : ''}</div>`)
    : '';
  openSheet(`<form id="form">${head}${autoActs}
    <label>タイトル</label><input type="text" id="f-title" required value="${esc(x?.title)}" placeholder="例：打ち合わせ" ${x?.auto ? 'readonly' : ''}>
    <label>日付</label><input type="date" id="f-date" required value="${x ? x.date : sel}">
    <div class="row"><div><label>開始</label><input type="time" id="f-start" value="${x ? x.start : s !== undefined ? fm(s) : ''}"></div>
      <div><label>終了</label><input type="time" id="f-end" value="${x ? x.end : e !== undefined ? fm(e) : ''}"></div></div>
    ${x?.auto ? '' : `<label>場所（任意）</label><select id="f-place"><option value="">指定なし</option>${placeNames().map((n) => `<option value="${esc(n)}" ${x?.place === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    <label>メモ（時間を空欄にすると「時間なし」の予定）</label><textarea id="f-memo" rows="2">${esc(x?.memo)}</textarea>
    <label>色</label>${colorPicker(x?.color || COLORS[0], x?.color ? [x.color] : [])}`}
    <div class="acts">
      ${x ? `<button type="button" class="del" id="f-del">${x.auto ? (x.kind === 'todo' ? 'ToDo を開く' : '習慣を開く') : '削除'}</button>` : ''}
      <button type="button" id="f-cancel">閉じる</button>
      <button type="submit" class="pri">保存</button>
    </div></form>`, (p) => {
    $('#f-cancel', p).onclick = closeSheet;
    $('#form', p).onsubmit = (ev) => {
      ev.preventDefault();
      let st = $('#f-start', p).value, en = $('#f-end', p).value;
      if (st && !en) en = fm(Math.min(1439, toM(st) + 60));
      if (!st) en = '';
      if (st && toM(en) <= toM(st)) return toast('終了は開始より後にしてください');
      const date = $('#f-date', p).value;
      if (x?.auto) {
        if (!st) return toast('自動配置の枠には時間が必要です');
        const moved = date !== x.date || st !== x.start || en !== x.end;
        if (moved) store.put('event', { ...x, date, start: st, end: en, pinned: true });
      } else {
        const o = { title: $('#f-title', p).value.trim(), date, start: st, end: en, memo: $('#f-memo', p).value, place: $('#f-place', p).value, color: $('input[name=c]:checked', p)?.value || COLORS[0] };
        store.put('event', { id: x?.id || uid(), ...o });
      }
      sel = date;
      closeSheet();
    };
    const del = $('#f-del', p);
    if (del) del.onclick = () => {
      if (x.auto) { closeSheet(); return x.kind === 'todo' ? openTodo(x.ref) : openHabit(x.ref); }
      if (confirm('この予定を削除しますか？')) { store.remove('event', x.id); closeSheet(); }
    };
    const done = $('#f-done', p);
    if (done && src) done.onclick = () => { store.put('todo', { ...src, done: !src.done, doneAt: src.done ? null : new Date().toISOString() }); toast(src.done ? '未完了に戻しました' : '完了！おつかれさまでした'); closeSheet(); };
    const skip = $('#f-skip', p);
    if (skip && src) skip.onclick = () => { store.put('habit', { ...src, skip: [...new Set([...(src.skip || []), x.date])].filter((d) => d >= addDays(ymd(new Date()), -30)) }); closeSheet(); };
    const unpin = $('#f-unpin', p);
    if (unpin) unpin.onclick = () => { store.put('event', { ...x, pinned: false }); closeSheet(); };
  });
}

// ---------------------------------------------------------------- ToDo
const PRI = { 1: '低', 2: '中', 3: '高' };
function placementOf(id) {
  const today = ymd(new Date());
  return events().filter((e) => e.auto && e.kind === 'todo' && e.ref === id && e.date >= today)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

function renderTodos() {
  $('#todo-hint').textContent = ai.aiAvailable()
    ? '✨ 追加すると AI が所要時間を見積もり、今後1週間の空き時間に自動で割り振ります。'
    : '追加すると所要時間を見積もり（ログインすると AI 見積もり）、今後1週間の空き時間に自動で割り振ります。';
  const list = store.all('todo');
  const manual = S().todoOrder !== 'due';
  const open = list.filter((t) => !t.done).sort(todoCompare(S()));
  const done = list.filter((t) => t.done).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).slice(0, 20);
  const wrap = $('#todo-list');
  wrap.innerHTML = '';
  if (!list.length) { wrap.append(el('div', 'empty', 'ToDo はまだありません')); return; }
  const row = (t, idx) => {
    const b = el('div', 'card item' + (t.done ? ' done' : ''));
    const chk = el('button', 'check' + (t.done ? ' on' : ''), t.done ? '✓' : '');
    chk.setAttribute('aria-label', t.done ? '未完了に戻す' : '完了にする');
    chk.onclick = () => store.put('todo', { ...t, done: !t.done, doneAt: t.done ? null : new Date().toISOString() });
    const main = el('button', 'main');
    main.style.textAlign = 'left';
    main.append(el('div', 't', t.title));
    const m = el('div', 'm');
    if (estimating.has(t.id)) m.innerHTML = '<span><i class="spin"></i> 見積もり中…</span>';
    else if (t.minutes) m.append(el('span', 0, `約${dur(+t.minutes)}${t.estSource === 'ai' ? ' ✨' : ''}`));
    if (t.due) m.append(el('span', t.due < ymd(new Date()) ? 'ng' : '', `期限 ${label(t.due)}`));
    if (+t.priority === 3) m.append(el('span', 'ng', '優先度 高'));
    if (hasConstraint(t)) m.append(el('span', 'pill', describe(t)));
    if (!t.done && t.minutes) {
      const pl = placementOf(t.id);
      const un = unplaced.todos.find((u) => u.id === t.id);
      if (pl.length) m.append(el('span', 'ok', '→ ' + pl.map((e) => `${label(e.date)} ${e.start}`).join(', ')));
      if (un) m.append(el('span', 'ng', `⚠ ${dur(un.minutes)}ぶん${hasConstraint(t) ? '条件に合う空きがありません' : '空きが足りません'}`));
    }
    main.append(m);
    main.onclick = () => openTodo(t.id);
    b.append(chk, main);
    if (manual && !t.done) {
      const mv = el('div', 'mv');
      const up = el('button', '', '▲'), dn = el('button', '', '▼');
      up.setAttribute('aria-label', '先に回す'); dn.setAttribute('aria-label', '後に回す');
      up.disabled = idx === 0; dn.disabled = idx === open.length - 1;
      up.onclick = () => moveTodo(open, idx, -1);
      dn.onclick = () => moveTodo(open, idx, 1);
      mv.append(up, dn);
      b.append(mv);
    }
    return b;
  };
  wrap.append(el('div', 'sect', manual ? '割り振りの順番（上から先に空きへ入れます）' : '割り振りの順番：期限が近い順（設定で手動に変更できます）'));
  const l1 = el('div', 'list');
  open.forEach((t, i) => l1.append(row(t, i)));
  wrap.append(l1);
  if (done.length) {
    wrap.append(el('div', 'sect', '完了'));
    const l2 = el('div', 'list');
    done.forEach((t) => l2.append(row(t)));
    wrap.append(l2);
  }
}

/** open（表示順）の idx 番目を dir(-1/+1) だけ動かす。全件に連番を振り直してから入れ替える */
function moveTodo(open, idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= open.length) return;
  const arr = open.slice();
  [arr[idx], arr[j]] = [arr[j], arr[idx]];
  store.batch(({ put }) => arr.forEach((t, i) => { if (t.order !== (i + 1) * 10) put('todo', { ...t, order: (i + 1) * 10 }); }));
}

async function estimateTodos(todos) {
  todos.forEach((t) => estimating.add(t.id));
  render();
  try {
    const res = await ai.estimate(todos.map((t) => ({ title: t.title, memo: t.memo || '' })));
    store.batch(({ put }) => todos.forEach((t, i) => {
      const cur = store.get('todo', t.id);
      if (cur) put('todo', { ...cur, minutes: res[i].minutes, estReason: res[i].reason, estSource: res[i].source });
    }));
  } finally {
    todos.forEach((t) => estimating.delete(t.id));
    render();
  }
}

$('#todo-add').onsubmit = (e) => {
  e.preventDefault();
  const title = $('#todo-in').value.trim();
  if (!title) return;
  const t = store.put('todo', { id: uid(), title, minutes: 0, priority: 2, due: '', memo: '', done: false, createdAt: new Date().toISOString(), order: Date.now() });
  $('#todo-in').value = '';
  estimateTodos([t]);
};
$('#replan').onclick = () => { replan(); render(); toast('空き時間に割り振り直しました'); };

function openTodo(id) {
  const t = store.get('todo', id);
  if (!t) return;
  const pl = placementOf(id);
  openSheet(`<form id="form"><h3>ToDo</h3>
    <label>タイトル</label><input type="text" id="t-title" required value="${esc(t.title)}">
    <div class="row">
      <div><label>所要時間（分）</label><input type="number" id="t-min" min="5" max="600" step="5" value="${+t.minutes || ''}"></div>
      <div><label>期限</label><input type="date" id="t-due" value="${esc(t.due)}"></div>
    </div>
    ${t.estReason ? `<p class="note">${t.estSource === 'ai' ? '✨ AI' : '目安'}：${esc(t.estReason)}</p>` : ''}
    <button type="button" class="ghost" id="t-ai" style="margin-top:6px">✨ 所要時間を見積もり直す</button>
    <label>優先度</label><div class="toggles" id="t-pri">${[3, 2, 1].map((p) => `<button type="button" class="tg ${(+t.priority || 2) === p ? 'on' : ''}" data-p="${p}">${PRI[p]}</button>`).join('')}</div>
    ${constraintFields(t)}
    <label>メモ</label><textarea id="t-memo" rows="2">${esc(t.memo)}</textarea>
    ${pl.length ? `<p class="note">配置：${pl.map((e) => `${label(e.date)} ${e.start}–${e.end}`).join('、')}</p>` : ''}
    <div class="acts"><button type="button" class="del" id="t-del">削除</button><button type="button" id="t-cancel">閉じる</button><button type="submit" class="pri">保存</button></div>
  </form>`, (p) => {
    const getC = bindConstraints(p, t);
    let pri = +t.priority || 2;
    p.querySelectorAll('#t-pri .tg').forEach((b) => (b.onclick = () => { pri = +b.dataset.p; p.querySelectorAll('#t-pri .tg').forEach((x) => x.classList.toggle('on', x === b)); }));
    $('#t-cancel', p).onclick = closeSheet;
    $('#t-del', p).onclick = () => { if (confirm('この ToDo を削除しますか？')) { store.remove('todo', id); closeSheet(); } };
    $('#t-ai', p).onclick = () => { closeSheet(); estimateTodos([{ ...t, title: $('#t-title', p).value.trim() || t.title }]); };
    $('#form', p).onsubmit = (e) => {
      e.preventDefault();
      const minutes = Math.max(0, Math.round((+$('#t-min', p).value || 0) / 5) * 5);
      store.put('todo', { ...t, title: $('#t-title', p).value.trim(), minutes, due: $('#t-due', p).value, priority: pri, memo: $('#t-memo', p).value, ...getC(), ...(minutes !== +t.minutes ? { estSource: 'manual', estReason: '' } : {}) });
      closeSheet();
    };
  });
}

// ---------------------------------------------------------------- 習慣
function renderHabits() {
  const wrap = $('#habit-list');
  wrap.innerHTML = '';
  const list = store.all('habit').sort((a, b) => (a.from || '').localeCompare(b.from || ''));
  if (!list.length) { wrap.append(el('div', 'empty', '＋ から習慣を追加できます（例：平日 6:00–8:00 にランニング30分）')); return; }
  const l = el('div', 'list');
  const today = ymd(new Date());
  for (const h of list) {
    const b = el('button', 'card item');
    const sw = el('span', 'swatch'); sw.style.background = h.color || HABIT_COLOR;
    const main = el('div', 'main');
    main.append(el('div', 't', h.title));
    const m = el('div', 'm');
    const days = (h.days || []).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    m.append(el('span', 0, days.length === 7 ? '毎日' : days.length ? days.map((d) => WD[d]).join('・') : '曜日なし'));
    m.append(el('span', 0, `${h.from}–${h.to} の間に ${dur(+h.minutes || 30)}`));
    const next = events().filter((e) => e.auto && e.kind === 'habit' && e.ref === h.id && e.date >= today).sort((a, c) => (a.date + a.start).localeCompare(c.date + c.start))[0];
    if (next) m.append(el('span', 'ok', `次回 ${label(next.date)} ${next.start}`));
    if (hasConstraint(h)) m.append(el('span', 'pill', describe(h)));
    const miss = unplaced.habits.filter((x) => x.id === h.id).length;
    if (miss) m.append(el('span', 'ng', `⚠ ${miss}日ぶん空きなし`));
    main.append(m);
    b.append(sw, main);
    b.onclick = () => openHabit(h.id);
    l.append(b);
  }
  wrap.append(l);
}

function openHabit(id) {
  const h = id ? store.get('habit', id) : null;
  const cur = h || { title: '', days: [1, 2, 3, 4, 5], from: '06:00', to: '09:00', minutes: 30, color: HABIT_COLOR };
  const order = [1, 2, 3, 4, 5, 6, 0];
  openSheet(`<form id="form"><h3>${h ? '習慣を編集' : '習慣を追加'}</h3>
    <label>タイトル</label><input type="text" id="h-title" required value="${esc(cur.title)}" placeholder="例：ランニング">
    <label>曜日</label><div class="toggles" id="h-days">${order.map((d) => `<button type="button" class="tg ${cur.days.includes(d) ? 'on' : ''}" data-d="${d}">${WD[d]}</button>`).join('')}</div>
    <label>この時間帯のどこかで</label>
    <div class="row"><div><input type="time" id="h-from" value="${cur.from}" required></div><div><input type="time" id="h-to" value="${cur.to}" required></div></div>
    <label>所要時間（分）</label><input type="number" id="h-min" min="5" max="600" step="5" value="${+cur.minutes || 30}" required>
    ${constraintFields(cur)}
    <label>色</label>${colorPicker(cur.color, [HABIT_COLOR, cur.color])}
    <div class="acts">${h ? '<button type="button" class="del" id="h-del">削除</button>' : ''}<button type="button" id="h-cancel">閉じる</button><button type="submit" class="pri">保存</button></div>
  </form>`, (p) => {
    const getC = bindConstraints(p, cur);
    const days = new Set(cur.days);
    p.querySelectorAll('#h-days .tg').forEach((b) => (b.onclick = () => { const d = +b.dataset.d; days.has(d) ? days.delete(d) : days.add(d); b.classList.toggle('on', days.has(d)); }));
    $('#h-cancel', p).onclick = closeSheet;
    if (h) $('#h-del', p).onclick = () => { if (confirm('この習慣を削除しますか？（今後の枠も消えます）')) { store.remove('habit', id); closeSheet(); } };
    $('#form', p).onsubmit = (e) => {
      e.preventDefault();
      const from = $('#h-from', p).value, to = $('#h-to', p).value, minutes = +$('#h-min', p).value;
      if (toM(to) - toM(from) < minutes) return toast('時間帯が所要時間より短いです');
      if (!days.size) return toast('曜日を1つ以上選んでください');
      store.put('habit', { ...(h || { id: uid(), skip: [] }), title: $('#h-title', p).value.trim(), days: [...days], from, to, minutes, ...getC(), color: $('input[name=c]:checked', p)?.value || HABIT_COLOR });
      closeSheet();
    };
  });
}

// ---------------------------------------------------------------- 設定
const NOTIFY_OPTS = [0, 5, 10, 15, 30, 60];
async function renderSettings() {
  const s = S();
  const user = sync.currentUser();
  const st = sync.getStatus();
  const sub = await push.currentSubscription().catch(() => null);
  const perm = push.permission();
  const box = $('#settings');
  box.innerHTML = `
  <div class="card group">
    <h2>活動時間</h2>
    <div class="srow"><span>開始</span><input type="time" data-k="dayStart" value="${s.dayStart}"></div>
    <div class="srow"><span>終了</span><input type="time" data-k="dayEnd" value="${s.dayEnd}"></div>
    <div class="srow"><span>空き時間とみなす長さ<small>これ以上の隙間を「空き」として表示</small></span><input type="number" min="5" max="240" step="5" data-k="minFree" value="${s.minFree}">分</div>
  </div>
  <div class="card group">
    <h2>予定の前後の余白</h2>
    <div class="srow"><span>予定の前<small>移動・準備の時間</small></span><input type="number" min="0" max="180" step="5" data-k="bufferBefore" value="${s.bufferBefore}">分</div>
    <div class="srow"><span>予定の後</span><input type="number" min="0" max="180" step="5" data-k="bufferAfter" value="${s.bufferAfter}">分</div>
  </div>
  <div class="card group">
    <h2>自動配置</h2>
    <div class="srow"><span>ToDo を分割する最小単位</span><input type="number" min="5" max="240" step="5" data-k="minChunk" value="${s.minChunk}">分</div>
    <div class="srow"><span>条件つきを先に入れる<small>場所などの条件があるものは入れる枠が限られるので、先に配置します</small></span><select data-k="constrainedFirst"><option value="1">先に入れる</option><option value="0">並び順どおり</option></select></div>
    <div class="srow"><span>ToDo を入れる順番<small>手動：ToDo 画面の ▲▼ で並べた順</small></span><select data-k="todoOrder"><option value="manual">手動の順番</option><option value="due">期限が近い順</option></select></div>
    <div class="srow"><span>配置する期間</span><input type="number" min="1" max="28" step="1" data-k="horizon" value="${s.horizon}">日</div>
  </div>
  <div class="card group">
    <h2>場所</h2>
    <div class="srow"><span>ふだんいる場所<small>予定のない時間は、ここにいるとみなします</small></span><select data-k="home">${(s.places || []).map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}</select></div>
    ${(s.places || []).map((p, i) => `<div class="srow"><span>${esc(p.name)}</span><label class="chk"><input type="checkbox" data-pt="${i}" ${p.transit ? 'checked' : ''}> 移動中</label><button class="ghost" data-pd="${i}" aria-label="${esc(p.name)}を削除">削除</button></div>`).join('')}
    <div class="srow"><input type="text" class="wide" id="place-new" placeholder="場所を追加（例：ジム）" maxlength="12"><button class="pri" id="place-add">追加</button></div>
    <p class="hint">「移動中」にした場所（電車など）の予定のなかでは、その場所でできる ToDo を入れられます。予定には場所を付けておくと、前後の隙間の場所が決まります。</p>
  </div>
  <div class="card group">
    <h2>通知</h2>
    <div class="srow"><span>予定の何分前に通知</span></div>
    <div class="toggles" id="notify" style="padding-bottom:10px">${NOTIFY_OPTS.map((m) => `<button type="button" class="tg ${s.notify.includes(m) ? 'on' : ''}" data-m="${m}">${m ? m + '分前' : '開始時'}</button>`).join('')}</div>
    <div class="srow"><span>この端末で通知を受け取る<small>${pushNote(perm, sub, user)}</small></span>
      ${sub ? '<button class="ghost" id="push-off">オフにする</button>' : '<button class="pri" id="push-on">オンにする</button>'}</div>
    ${perm === 'granted' ? '<div class="srow"><span>テスト</span><button class="ghost" id="push-test">通知を試す</button></div>' : ''}
  </div>
  <div class="card group">
    <h2>同期</h2>
    ${!sync.enabled() ? '<div class="srow"><span>この端末のみで保存中<small>config.js に Supabase の URL とキーを設定すると、端末間で同期できます（README 参照）</small></span></div>'
    : user ? `<div class="srow"><span>${esc(user.email)}<small class="status ${st.state}"><i></i>${esc(st.message)}</small></span><button class="ghost" id="sync-now">今すぐ同期</button></div>
             <div class="srow"><span></span><button class="ghost" id="logout">ログアウト</button></div>`
    : `<div class="srow"><span>メールアドレスでログインすると、ほかの端末と同期し、AI 見積もりと Web Push が使えます。</span></div>
       <div class="srow"><input type="email" class="wide" id="login-email" placeholder="you@example.com" autocomplete="email"><button class="pri" id="login-send">コード送信</button></div>
       <div class="srow" id="code-row" hidden><input type="text" class="wide" id="login-code" inputmode="numeric" autocomplete="one-time-code" placeholder="メールの6桁コード"><button class="pri" id="login-verify">ログイン</button></div>`}
  </div>
  <div class="card group">
    <h2>表示</h2>
    <div class="srow"><span>テーマ</span><select data-k="theme"><option value="auto">端末に合わせる</option><option value="light">ライト</option><option value="dark">ダーク</option></select></div>
  </div>
  <div class="card group">
    <h2>データ</h2>
    <div class="srow"><span>バックアップ</span><button class="ghost" id="export">書き出し</button><button class="ghost" id="import">読み込み</button></div>
  </div>
  <p class="hint" style="text-align:center">マイスケジュール PWA</p>`;
  box.querySelector('select[data-k=theme]').value = s.theme || 'auto';
  box.querySelector('select[data-k=todoOrder]').value = s.todoOrder || 'manual';
  box.querySelector('select[data-k=constrainedFirst]').value = String(s.constrainedFirst) === '0' ? '0' : '1';
  box.querySelector('select[data-k=home]').value = s.home || '家';
  box.querySelectorAll('[data-pt]').forEach((c) => (c.onchange = () => store.setSettings({ places: S().places.map((p, i) => (i === +c.dataset.pt ? { ...p, transit: c.checked } : p)) })));
  box.querySelectorAll('[data-pd]').forEach((b) => (b.onclick = () => {
    const p = S().places[+b.dataset.pd];
    if (!confirm(`「${p.name}」を削除しますか？（この場所を指定した予定・ToDo の条件は効かなくなります）`)) return;
    const places = S().places.filter((_, i) => i !== +b.dataset.pd);
    store.setSettings({ places, ...(S().home === p.name ? { home: places[0]?.name || '' } : {}) });
  }));
  $('#place-add').onclick = () => {
    const name = $('#place-new').value.trim();
    if (!name) return;
    if (S().places.some((p) => p.name === name)) return toast('同じ名前の場所があります');
    store.setSettings({ places: [...S().places, { name, transit: false }] });
  };
  box.querySelectorAll('[data-k]').forEach((inp) => (inp.onchange = () => {
    const k = inp.dataset.k;
    let v = inp.value;
    if (inp.type === 'number') v = Math.max(+inp.min || 0, Math.min(+inp.max || 999, Math.round(+v || 0)));
    if ((k === 'dayStart' || k === 'dayEnd')) {
      const a = k === 'dayStart' ? v : s.dayStart, b = k === 'dayEnd' ? v : s.dayEnd;
      if (!v || toM(b) <= toM(a)) { toast('終了は開始より後にしてください'); inp.value = s[k]; return; }
    }
    store.setSettings({ [k]: v });
    if (k === 'theme') applyTheme();
  }));
  box.querySelectorAll('#notify .tg').forEach((b) => (b.onclick = () => {
    const m = +b.dataset.m, set = new Set(S().notify);
    set.has(m) ? set.delete(m) : set.add(m);
    store.setSettings({ notify: [...set].sort((a, c) => a - c) });
  }));
  const on = $('#push-on'), off = $('#push-off');
  if (on) on.onclick = async () => {
    try {
      const mode = await push.enable();
      toast(mode === 'push' ? '通知をオンにしました' : 'アプリを開いている間だけ通知します（ログインでアプリを閉じても届きます）');
    } catch (e) { toast(e.message || '通知を有効にできませんでした'); }
    render();
    push.scheduleLocal(events(), S());
  };
  if (off) off.onclick = async () => { await push.disable(); toast('通知をオフにしました'); render(); };
  const tst = $('#push-test'); if (tst) tst.onclick = () => push.test();
  const sn = $('#sync-now'); if (sn) sn.onclick = () => sync.syncNow();
  const lo = $('#logout'); if (lo) lo.onclick = async () => { if (confirm('ログアウトしますか？（この端末のデータは残ります）')) { await push.disable().catch(() => {}); await sync.signOut(); render(); } };
  const ls = $('#login-send');
  if (ls) ls.onclick = async () => {
    const email = $('#login-email').value.trim();
    if (!email) return;
    ls.disabled = true;
    try { await sync.sendCode(email); $('#code-row').hidden = false; $('#login-code').focus(); toast('メールにコードを送りました'); }
    catch (e) { toast(e.message || '送信できませんでした'); }
    ls.disabled = false;
  };
  const lv = $('#login-verify');
  if (lv) lv.onclick = async () => {
    try { await sync.verifyCode($('#login-email').value.trim(), $('#login-code').value.trim()); toast('ログインしました'); }
    catch (e) { toast(e.message || 'コードが正しくありません'); }
  };
  $('#export').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([store.exportJSON()], { type: 'application/json' }));
    a.download = `schedule-${ymd(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#import').onclick = () => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = 'application/json,.json';
    i.onchange = async () => {
      try { store.importJSON(await i.files[0].text()); toast('読み込みました'); }
      catch { toast('読み込めませんでした'); }
    };
    i.click();
  };
}

function pushNote(perm, sub, user) {
  if (!push.supported()) return push.isIOS() && !push.isStandalone() ? 'iPhone は共有 →「ホーム画面に追加」したアプリで使えます' : 'このブラウザは通知に未対応です';
  if (perm === 'denied') return 'ブラウザの設定で通知がブロックされています';
  if (sub) return 'オン（アプリを閉じていても届きます）';
  if (perm === 'granted') return user ? 'アプリを開いている間のみ。オンにするとアプリを閉じても届きます' : 'アプリを開いている間のみ（ログインで常時）';
  return 'オフ';
}

// ---------------------------------------------------------------- イベント
$('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); };
$('#fab').onclick = () => {
  if (tab === 'day') {
    const fr = freeSlots(events(), sel, S(), new Date())[0];
    fr ? openEvent(null, fr[0], Math.min(fr[1], fr[0] + 60)) : openEvent(null);
  } else if (tab === 'todo') $('#todo-in').focus();
  else if (tab === 'habit') openHabit(null);
};
const shift = (n) => { sel = addDays(sel, n); render(); };
$('#prev').onclick = () => shift(-1);
$('#next').onclick = () => shift(1);
$('#today').onclick = () => { sel = ymd(new Date()); render(); };
$('#jump').onchange = (e) => { if (e.target.value) { sel = e.target.value; render(); } };
$('#week').onclick = (e) => { const b = e.target.closest('[data-d]'); if (b) { sel = b.dataset.d; render(); } };
// 左右スワイプで日送り
let sx = null, sy = 0;
$('#tl').addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
$('#tl').addEventListener('touchend', (e) => {
  if (sx === null) return;
  const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
  sx = null;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) shift(dx < 0 ? 1 : -1);
}, { passive: true });

store.onChange(() => {
  applyTheme();
  scheduleReplan();
  push.scheduleLocal(events(), S());
});
sync.onStatus(() => { if (tab === 'settings' && !sheetOpen) render(); });

// 1分ごとに「今」を更新し、日付が変わったら配置し直す
let lastDay = ymd(new Date());
setInterval(() => {
  const d = ymd(new Date());
  if (d !== lastDay) { if (sel === lastDay) sel = d; lastDay = d; replan(); }
  if (!sheetOpen && tab === 'day') render();
}, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { replan(); if (!sheetOpen) render(); } });

// ---------------------------------------------------------------- 起動
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.date) { sel = e.data.date; setTab('day'); }
  });
}
applyTheme();
replan();
setTab(tab);
push.scheduleLocal(events(), S());
sync.init().then(() => { if (!sheetOpen) render(); });

