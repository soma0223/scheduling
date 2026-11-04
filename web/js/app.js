import * as store from './store.js';
import * as sync from './sync.js';
import * as push from './push.js';
import * as ai from './ai.js';
import { plan, freeSlots, freeTotal, todoCompare, dayBounds, logicalNow, normalizeEvents, normalizeEvent, HABIT_COLOR } from './scheduler.js';
import { expandEvents, nextMatching, describeRepeat, repeatTodoInstances, describeTodoRepeat, isTodoTemplate } from './recurrence.js';
import { hasConstraint, describe, taskPlaceNames, eventPlaceNames, travelSegments } from './constraints.js';
import { WD, toM, fm, dur, ymd, pd, addDays, minutesOf, label, uid } from './util.js';

const COLORS = ['#2f6fed', '#e0573d', '#2e9e6b', '#d49a1a', '#8b5cf6'];
const H = 52; // 1時間の高さ(px)
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const el = (tag, cls, txt) => { const x = document.createElement(tag); if (cls) x.className = cls; if (txt !== undefined) x.textContent = txt; return x; };

const qs = new URLSearchParams(location.search);
// 活動時間が翌日にまたがるとき、深夜0〜2時は「前日の夜」。「今日」は論理日で数える
const logicalToday = () => logicalNow(new Date(), store.settings()).date;
const de0 = (s) => dayBounds(s).de;
// 論理日の分（24:00 以降は「翌」）の表示用
const clock = (m) => (m >= 1440 ? '翌' + fm(m - 1440) : fm(m));
let sel = /^\d{4}-\d{2}-\d{2}$/.test(qs.get('date') || '') ? qs.get('date') : logicalToday();
let tab = ['day', 'todo', 'habit', 'settings'].includes(qs.get('tab')) ? qs.get('tab') : 'day';
let unplaced = { todos: [], habits: [] };
const estimating = new Set();
let sheetOpen = false;

const S = () => store.settings();
// 繰り返しの予定は、見ている日の前後（と配置期間）ぶんを「回」に展開して返す
const events = () => {
  const t = logicalToday();
  const lo = sel < t ? sel : t, hi = sel > addDays(t, 40) ? sel : addDays(t, 40);
  return expandEvents(store.all('event'), addDays(lo, -9), addDays(hi, 9));
};

// ---------------------------------------------------------------- テーマ
function applyTheme() {
  const t = S().theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---------------------------------------------------------------- 自動配置
let replanTimer = null;
function replan(now = new Date(), fresh = false) {
  const r = plan({ events: store.raw('event'), todos: store.raw('todo'), habits: store.raw('habit'), settings: S() }, now, { fresh });
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
// 並び順などを変えたときは、置き済みの枠も並べ直す（freshNext）
let freshNext = false;
const scheduleReplan = () => {
  clearTimeout(replanTimer);
  replanTimer = setTimeout(() => { const f = freshNext; freshNext = false; if (!replan(new Date(), f)) render(); }, 50);
};

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
  // 設定の入力中（iPhone の時刻ピッカーなど）に描き直すと、ピッカーが閉じてしまう。入力が終わってから描き直す
  const ae = document.activeElement;
  if (tab === 'settings' && ae && ae.matches?.('input,select') && $('#settings').contains(ae)) return;
  if (tab === 'day') renderDay();
  else if (tab === 'todo') renderTodos();
  else if (tab === 'habit') renderHabits();
  else renderSettings();
}

// ---------------------------------------------------------------- 1日ビュー
function renderDay() {
  const now = new Date(), s = S(), ln = logicalNow(now, s), today = ln.date, isToday = sel === today;
  const sd = pd(sel);
  $('#ttl').textContent = `${sd.getMonth() + 1}月${sd.getDate()}日（${WD[sd.getDay()]}）`;
  $('#jump').value = sel;

  // 週ストリップ（日曜はじまり）
  const raw = events();
  const rawById = new Map(raw.map((e) => [e.id, e]));
  const all = normalizeEvents(raw, s); // 論理日の予定（深夜は前日の 24:00〜）
  const w0 = addDays(sel, -sd.getDay());
  let wh = '';
  for (let i = 0; i < 7; i++) {
    const k = addDays(w0, i), d = pd(k);
    const dots = all.filter((e) => e.date === k).slice(0, 4).map((e) => `<i class="dot" style="background:${esc(e.color)}"></i>`).join('');
    const ft = k >= today ? freeTotal(raw, k, s, now) : 0;
    wh += `<button class="wk ${i == 0 ? 'sun' : i == 6 ? 'sat' : ''} ${k == today ? 'today' : ''} ${k == sel ? 'sel' : ''}" data-d="${k}">${WD[i]}<b>${d.getDate()}</b><span class="dots">${dots}</span><span class="fr">${ft ? Math.round(ft / 30) / 2 + 'h' : ''}</span></button>`;
  }
  $('#week').innerHTML = wh;

  const items = all.filter((e) => e.date === sel).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const timed = items.filter((e) => e.start), plain = items.filter((e) => !e.start);

  // サマリー
  const fr = sel < today ? [] : freeSlots(raw, sel, s, now);
  const sum = $('#sum');
  sum.innerHTML = '';
  const tot = fr.reduce((a, [x, y]) => a + y - x, 0);
  const big = el('div', 'big');
  big.append(isToday ? 'この先の空き時間 ' : '空き時間 ', el('b', 0, tot ? dur(tot) : 'なし'));
  sum.append(big);
  sum.append(el('div', 'sub', `活動時間 ${s.dayStart}–${toM(s.dayEnd) <= toM(s.dayStart) ? '翌' : ''}${s.dayEnd}・${s.minFree}分以上の隙間を表示`));
  const ch = el('div', 'chips');
  fr.forEach(([a, b]) => {
    const c = el('button', 'chip', `${clock(a)}–${clock(b)}（${dur(b - a)}）`);
    c.onclick = () => openEvent(null, a, Math.min(b, a + 60));
    ch.append(c);
  });
  plain.forEach((e) => { const c = el('button', 'ad', e.title); c.onclick = () => openEvent(e.id); ch.append(c); });
  if (ch.children.length) sum.append(ch);
  if (isToday && ln.min >= de0(s)) sum.append(el('div', 'warn', `いまは活動時間（${s.dayStart}–${toM(s.dayEnd) <= toM(s.dayStart) ? '翌' : ''}${s.dayEnd}）の外です。今日の残りには配分されません（設定で変えられます）`));
  const uh = unplaced.habits.filter((x) => x.date === sel);
  renderDayTodos(sel);
  if (uh.length) sum.append(el('div', 'warn', '⚠ 入りきらない習慣: ' + uh.map((x) => store.get('habit', x.id)?.title).filter(Boolean).join('、')));

  // タイムライン
  const { ds, de } = dayBounds(s);
  const hs = Math.max(0, Math.min(Math.floor(ds / 60) - 1, ...timed.map((e) => Math.floor(toM(e.start) / 60))));
  const he = Math.max(24, Math.ceil(de / 60));
  const tl = $('#tl');
  tl.innerHTML = '';
  tl.style.height = (he - hs) * H + 'px';
  const Y = (m) => ((m - hs * 60) * H) / 60;
  for (let h = hs; h < he; h++) {
    const l = el('div', 'hl');
    l.style.top = (h - hs) * H + 'px';
    l.append(el('span', 0, (h >= 24 ? '翌' + (h - 24) : h) + ':00'));
    tl.append(l);
  }
  // 活動時間外を薄く
  const shade = (a, b) => { if (b <= a) return; const o = el('div', 'off'); o.style.top = Y(a) + 'px'; o.style.height = ((b - a) * H) / 60 + 'px'; tl.append(o); };
  shade(hs * 60, ds); shade(de, he * 60);
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
  const trips = travelSegments(all, s).filter((t) => t.date === sel); // 場所が変わるときの移動時間（自動）
  const L = [...timed, ...trips].sort((a, b) => toM(a.start) - toM(b.start)).map((e) => ({ e, s: toM(e.start), f: toM(e.end), c: 0, n: 1 }));
  let grp = [], gend = 0;
  const flush = () => { const n = Math.max(0, ...grp.map((x) => x.c)) + 1; grp.forEach((x) => (x.n = n)); grp = []; };
  L.forEach((x) => {
    if (grp.length && x.s >= gend) flush();
    const used = grp.filter((y) => y.f > x.s).map((y) => y.c);
    let c = 0; while (used.includes(c)) c++;
    x.c = c; grp.push(x); gend = Math.max(gend, x.f);
  });
  flush();
  const nm = ln.min;
  L.forEach((x) => {
    const e = x.e, d = el(e.virtual ? 'div' : 'button', 'blk' + (e.auto ? ' auto' : '') + (e.virtual ? ' travel' : ''));
    if (sel < today || (isToday && x.f <= nm)) d.classList.add('past');
    d.style.top = Y(x.s) + 'px';
    d.style.height = Math.max(22, ((x.f - x.s) * H) / 60 - 2) + 'px';
    d.style.left = `calc(${(x.c * 100) / x.n}% + 2px)`;
    d.style.width = `calc(${100 / x.n}% - 4px)`;
    d.style.background = e.color + '30';
    d.style.borderColor = e.color;
    const t = el('div');
    if (e.auto) t.append(el('span', 'tag', e.kind === 'todo' ? (store.get('todo', e.ref)?.done ? '✓ToDo' : 'ToDo') : '習慣'));
    if (e.series) t.append(el('span', 'tag', '🔁'));
    t.append(e.title);
    const r = rawById.get(e.id) || e; // 表示は実際の時刻
    d.append(t, el('small', 0, `${r.start}–${r.end}${e.place ? '・' + e.place : ''}${e.pinned ? '・固定' : ''}`));
    if (e.virtual) { d.innerHTML = ''; d.append(el('div', 0, '→ ' + e.title), el('small', 0, `${e.start}–${e.end}・${e.minutes}分`)); d.style.background = ''; d.style.borderColor = ''; }
    else d.onclick = () => openEvent(e.id);
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
const placeNames = () => taskPlaceNames(S()); // ToDo・習慣の「できる場所」の候補

/** 場所を設定に追加する。成功したら名前、失敗（空・重複）なら null */
function addPlace(raw) {
  const name = String(raw || '').trim().slice(0, 12);
  if (!name) return null;
  const st = S();
  if ((st.places || []).some((p) => p.name === name) || (st.modes || []).some((m) => m.name === name)) { toast('同じ名前の場所があります'); return null; }
  store.setSettings({ places: [...(st.places || []), { name, transit: false }] });
  toast(`「${name}」を追加しました`);
  return name;
}
// 入力欄で Enter を押したとき、フォーム全体が送信されないように「追加」を押す
const enterToClick = (input, btn) => input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); btn.click(); } });

const PREFER = [['', '指定なし'], ['morning', '朝（〜12時）'], ['afternoon', '午後（12〜18時）'], ['evening', '夜（18時〜）']];
function constraintFields(cur) {
  const names = placeNames();
  const sel = new Set(cur.places || []);
  const titles = [...new Set(events().filter((e) => !e.auto && e.title).map((e) => e.title))].slice(0, 30);
  const hours = cur.after?.min ? +(cur.after.min / 60).toFixed(2) : '';
  return `<label>時間帯の好み（その時間帯に空きがあれば優先。無ければほかの時間）</label>
    <div class="toggles" id="c-prefer">${PREFER.map(([v, l]) => `<button type="button" class="tg ${(cur.prefer || '') === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>
    <label>できる場所（選ばなければ、どこでも）</label>
    <div class="toggles" id="c-places">${names.map((n) => `<button type="button" class="tg ${sel.has(n) ? 'on' : ''}" data-p="${esc(n)}">${esc(n)}</button>`).join('')}<button type="button" class="tg" id="c-addp">＋ 場所を追加</button></div>
    <div id="c-newplace" class="row" hidden style="margin-top:8px"><div><input type="text" id="c-np" maxlength="12" placeholder="場所の名前（例：ジム）"></div><div style="flex:none"><button type="button" class="pri" id="c-npadd">追加</button></div></div>
    <label>この予定のあとから（例：「学校」の 2 時間後から）</label>
    <div class="row"><div><input type="text" id="c-key" list="c-keys" placeholder="例：学校" value="${esc(cur.after?.key)}"></div>
      <div><input type="number" id="c-hours" min="0" max="12" step="0.5" placeholder="何時間後" value="${hours}"></div></div>
    <datalist id="c-keys">${[...names, ...titles].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <p class="note">その日にその予定があるときだけ有効です。無い日は制限なし。</p>
    <label>時刻の制限（空欄なら制限なし）</label>
    <div class="row"><div><label style="margin-top:0">この時刻以降に始める</label><input type="time" id="c-nb" value="${esc(cur.notBefore)}"></div>
      <div><label style="margin-top:0">この時刻までに終える</label><input type="time" id="c-na" value="${esc(cur.notAfter)}"></div></div>`;
}

function bindConstraints(p, cur) {
  let prefer = cur.prefer || '';
  p.querySelectorAll('#c-prefer .tg').forEach((b) => (b.onclick = () => {
    prefer = b.dataset.v;
    p.querySelectorAll('#c-prefer .tg').forEach((x) => x.classList.toggle('on', x === b));
  }));
  const set = new Set(cur.places || []);
  const wire = (b) => (b.onclick = () => {
    const n = b.dataset.p;
    set.has(n) ? set.delete(n) : set.add(n);
    b.classList.toggle('on', set.has(n));
  });
  p.querySelectorAll('#c-places .tg[data-p]').forEach(wire);
  const addBtn = $('#c-addp', p), npRow = $('#c-newplace', p), npIn = $('#c-np', p);
  addBtn.onclick = () => { npRow.hidden = !npRow.hidden; if (!npRow.hidden) npIn.focus(); };
  $('#c-npadd', p).onclick = () => {
    const n = addPlace(npIn.value);
    if (!n) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tg on'; b.dataset.p = n; b.textContent = n;
    wire(b); set.add(n); addBtn.before(b);
    npIn.value = ''; npRow.hidden = true;
  };
  enterToClick(npIn, $('#c-npadd', p));
  return () => {
    const key = $('#c-key', p).value.trim();
    const h = parseFloat($('#c-hours', p).value);
    return { places: [...set], after: key ? { key, min: Math.max(0, Math.round((Number.isFinite(h) ? h : 0) * 60)) } : null, notBefore: $('#c-nb', p).value || '', notAfter: $('#c-na', p).value || '', prefer };
  };
}

// ---------------------------------------------------------------- 予定シート
/** 予定ごとの移動の指定。null=ルート設定どおり、{minutes:0}=移動なし */
function readTravel(p, modeId = 'f-tmode', minId = 'f-tmin') {
  const pv = $('#f-place', p).value;
  if (!pv || pv === '__new__') return null;
  const m = $('#' + modeId, p).value, mi = $('#' + minId, p).value;
  if (m === '-') return { mode: '', minutes: 0 };
  if (!m && mi === '') return null;
  return { mode: m, minutes: mi === '' ? null : Math.max(5, Math.round(+mi)) };
}

function openEvent(id, s, e) {
  // 繰り返しの「回」は id が `親id@日付`。編集は親（すべての回）に対して行う
  const [sid, inst] = id ? String(id).split('@') : [null, null];
  const x = sid ? store.get('event', sid) : null;
  const repDays = new Set(x?.repeat?.days || []);
  let endMode = +x?.repeat?.count > 0 ? 'count' : x?.repeat?.until ? 'until' : '';
  // 空き枠から追加するとき：論理日の分(24:00以降あり) → 実際の日付・時刻。24:00 をまたぐ場合は 24:00 で切る
  let nDate = sel;
  if (s !== undefined) {
    if (s >= 1440) { nDate = addDays(sel, 1); s -= 1440; e = e === undefined ? undefined : e - 1440; }
    else if (e !== undefined && e > 1440) e = 1440 - 1;
  }
  const src = x?.auto ? store.get(x.kind, x.ref) : null;
  const head = x?.auto
    ? `<h3>${x.kind === 'todo' ? 'ToDo の作業枠' : '習慣'}：${esc(x.title)}</h3><p class="note">自動で配置された枠です。時間を変えると「固定」になり、再配置で動かなくなります。</p>`
    : `<h3>${x ? '予定を編集' : '予定を追加'}</h3>`;
  const autoActs = x?.auto
    ? (x.kind === 'todo'
      ? `<div class="acts"><button type="button" class="ok" id="f-done">${src?.done ? '未完了に戻す' : '✓ ToDo を完了'}</button>${x.pinned ? '<button type="button" id="f-unpin">固定を解除</button>' : ''}</div>`
      : `<div class="acts"><button type="button" id="f-skip">この日はスキップ</button>${x.pinned ? '<button type="button" id="f-unpin">固定を解除</button>' : ''}</div>`)
    : '';
  const instActs = inst && x?.repeat ? `<p class="note">${esc(describeRepeat(x.repeat, WD))}の予定です。下の変更は、すべての回に反映されます。</p>
    <div class="acts"><button type="button" id="f-skipday">この日（${inst.slice(5).replace('-', '/')}）だけ削除</button><button type="button" id="f-oneoff">この日だけ変更</button></div>` : '';
  openSheet(`<form id="form">${head}${autoActs}${instActs}
    <label>タイトル</label><input type="text" id="f-title" required value="${esc(x?.title)}" placeholder="例：打ち合わせ" ${x?.auto ? 'readonly' : ''}>
    <label>${repDays.size ? '日付（繰り返しは、この日から）' : '日付'}</label><input type="date" id="f-date" required value="${x ? x.date : nDate}">
    <div class="row"><div><label>開始</label><input type="time" id="f-start" value="${x ? x.start : s !== undefined ? fm(s) : ''}"></div>
      <div><label>終了</label><input type="time" id="f-end" value="${x ? x.end : e !== undefined ? fm(e) : ''}"></div></div>
    ${x?.auto ? '' : `<label>場所（任意）</label><select id="f-place"><option value="">指定なし</option>${eventPlaceNames(S()).map((n) => `<option value="${esc(n)}" ${x?.place === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}<option value="__new__">＋ 場所を追加…</option></select>
    <div id="f-newplace" class="row" hidden style="margin-top:8px"><div><input type="text" id="f-np" maxlength="12" placeholder="場所の名前（例：ジム）"></div><div style="flex:none"><button type="button" class="pri" id="f-npadd">追加</button></div></div>
    <div id="f-trip" ${x?.place ? '' : 'hidden'}>
      <label>ここへの移動（場所が変わるときだけ使われます）</label>
      <div class="row"><div><select id="f-tmode"><option value="">設定のルートどおり</option><option value="-" ${x?.travel && x.travel.minutes === 0 ? 'selected' : ''}>移動なし</option>${(S().modes || []).map((m) => `<option value="${esc(m.name)}" ${x?.travel?.minutes !== 0 && x?.travel?.mode === m.name ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
      <div><input type="number" id="f-tmin" min="5" max="300" step="5" placeholder="分（空=自動）" value="${x?.travel && x.travel.minutes ? x.travel.minutes : ''}"></div></div>
      <label>この予定のあとの帰宅（家以外で、その日の最後の予定のときに使われます）</label>
      <div class="row"><div><select id="f-hmode"><option value="">設定のルートどおり</option><option value="-" ${x?.travelAfter && x.travelAfter.minutes === 0 ? 'selected' : ''}>帰宅の移動なし</option>${(S().modes || []).map((m) => `<option value="${esc(m.name)}" ${x?.travelAfter?.minutes !== 0 && x?.travelAfter?.mode === m.name ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
      <div><input type="number" id="f-hmin" min="5" max="300" step="5" placeholder="分（空=自動）" value="${x?.travelAfter && x.travelAfter.minutes ? x.travelAfter.minutes : ''}"></div></div>
    </div>
    <label>繰り返し（曜日を選ぶと、毎週その曜日に入ります）</label>
    <div class="toggles" id="f-rep">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" class="tg ${repDays.has(d) ? 'on' : ''}" data-d="${d}">${WD[d]}</button>`).join('')}</div>
    <div id="f-until-wrap" ${repDays.size ? '' : 'hidden'}>
      <label>間隔</label>
      <select id="f-every">${[[1, '毎週'], [2, '隔週（2週に1回）'], [3, '3週ごと'], [4, '4週ごと']].map(([v, l]) => `<option value="${v}" ${(+x?.repeat?.every || 1) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label>終わり</label>
      <div class="toggles" id="f-endmode">${[['', 'ずっと'], ['until', '日付まで'], ['count', '回数まで']].map(([v, l]) => `<button type="button" class="tg ${endMode === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>
      <div id="f-end-until" ${endMode === 'until' ? '' : 'hidden'} style="margin-top:8px"><input type="date" id="f-until" value="${esc(x?.repeat?.until)}"></div>
      <div id="f-end-count" ${endMode === 'count' ? '' : 'hidden'} style="margin-top:8px"><div class="row" style="align-items:center"><div style="flex:none;width:90px"><input type="number" id="f-count" min="1" max="500" step="1" value="${+x?.repeat?.count || 10}"></div><div>回で終わる（「この日だけ削除」した回も数えます）</div></div></div>
    </div>
    <label>メモ（時間を空欄にすると「時間なし」の予定）</label><textarea id="f-memo" rows="2">${esc(x?.memo)}</textarea>
    <label>色</label>${colorPicker(x?.color || COLORS[0], x?.color ? [x.color] : [])}`}
    <div class="acts">
      ${x ? `<button type="button" class="del" id="f-del">${x.auto ? (x.kind === 'todo' ? 'ToDo を開く' : '習慣を開く') : '削除'}</button>` : ''}
      <button type="button" id="f-cancel">閉じる</button>
      <button type="submit" class="pri">保存</button>
    </div></form>`, (p) => {
    p.querySelectorAll('#f-rep .tg').forEach((b) => (b.onclick = () => {
      const d = +b.dataset.d;
      repDays.has(d) ? repDays.delete(d) : repDays.add(d);
      b.classList.toggle('on', repDays.has(d));
      $('#f-until-wrap', p).hidden = !repDays.size;
    }));
    p.querySelectorAll('#f-endmode .tg').forEach((b) => (b.onclick = () => {
      endMode = b.dataset.v;
      p.querySelectorAll('#f-endmode .tg').forEach((t) => t.classList.toggle('on', t === b));
      $('#f-end-until', p).hidden = endMode !== 'until';
      $('#f-end-count', p).hidden = endMode !== 'count';
    }));
    const skipDay = $('#f-skipday', p);
    if (skipDay) skipDay.onclick = () => { store.put('event', { ...x, skip: [...new Set([...(x.skip || []), inst])] }); closeSheet(); toast('この日だけ削除しました'); };
    const oneOff = $('#f-oneoff', p);
    if (oneOff) oneOff.onclick = () => {
      // この日の回を外して、同じ内容の単発の予定を作る（そちらを自由に直せる）
      const { id: _i, repeat: _r, skip: _s, updatedAt: _u, deleted: _d, series: _se, ...rest } = x;
      const copy = { ...rest, id: uid(), date: inst };
      store.batch(({ put }) => { put('event', { ...x, skip: [...new Set([...(x.skip || []), inst])] }); put('event', copy); });
      closeSheet();
      openEvent(copy.id);
    };
    const fp = $('#f-place', p);
    if (fp) {
      const showTrip = () => { $('#f-trip', p).hidden = !fp.value || fp.value === '__new__'; };
      fp.onchange = () => {
        $('#f-newplace', p).hidden = fp.value !== '__new__';
        if (fp.value === '__new__') $('#f-np', p).focus();
        showTrip();
      };
      $('#f-npadd', p).onclick = () => {
        const n = addPlace($('#f-np', p).value);
        if (!n) return;
        const o = document.createElement('option');
        o.value = n; o.textContent = n;
        fp.insertBefore(o, fp.querySelector('option[value="__new__"]'));
        fp.value = n;
        $('#f-np', p).value = ''; $('#f-newplace', p).hidden = true;
        showTrip();
      };
      enterToClick($('#f-np', p), $('#f-npadd', p));
    }
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
        if (repDays.size && !st) return toast('繰り返しの予定には時間が必要です');
        const rd = [...repDays];
        const until = endMode === 'until' ? $('#f-until', p).value : '';
        const count = endMode === 'count' ? Math.max(1, Math.round(+$('#f-count', p).value || 1)) : 0;
        if (rd.length && endMode === 'until' && !until) return toast('終わりの日付を入れてください');
        if (rd.length && until && until < nextMatching(date, rd)) return toast('終わりの日付が、最初の回より前です');
        const o = { title: $('#f-title', p).value.trim(), date: rd.length ? nextMatching(date, rd) : date, start: st, end: en,
          repeat: rd.length ? { days: rd, every: +$('#f-every', p).value || 1, until, count, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } : null, skip: rd.length ? (x?.skip || []) : [], memo: $('#f-memo', p).value, place: $('#f-place', p).value === '__new__' ? '' : $('#f-place', p).value, travel: readTravel(p), travelAfter: readTravel(p, 'f-hmode', 'f-hmin'), color: $('input[name=c]:checked', p)?.value || COLORS[0] };
        store.put('event', { id: x?.id || uid(), ...o });
      }
      if (!(x && x.repeat && repDays.size)) sel = normalizeEvent({ date: x?.auto ? date : repDays.size ? nextMatching(date, [...repDays]) : date, start: st, end: en }, S()).date; // 深夜の予定は前日の夜として表示
      closeSheet();
    };
    const del = $('#f-del', p);
    if (del) del.onclick = () => {
      if (x.auto) { closeSheet(); return x.kind === 'todo' ? openTodo(x.ref) : openHabit(x.ref); }
      if (confirm(x.repeat ? 'この繰り返しの予定を、すべての回ごと削除しますか？' : 'この予定を削除しますか？')) { store.remove('event', x.id); closeSheet(); }
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

// ---- この日のToDo / 日ごと表示で使う、完了チェックつきの行 ----
const tick = (t) => store.put('todo', { ...t, done: !t.done, doneAt: t.done ? null : new Date().toISOString() });
/** 論理日（深夜まで続く活動時間を考慮）で数えた、自動配置された ToDo の枠 */
function todoBlocks() {
  return normalizeEvents(events(), S()).filter((e) => e.auto && e.kind === 'todo' && !e.virtual);
}
function blockRow(e, rawById) {
  const t = store.get('todo', e.ref);
  const r = rawById.get(e.id) || e;
  const b = el('div', 'card item' + (t?.done ? ' done' : ''));
  const chk = el('button', 'check' + (t?.done ? ' on' : ''), t?.done ? '✓' : '');
  chk.setAttribute('aria-label', t?.done ? '未完了に戻す' : '完了にする');
  if (t) chk.onclick = () => tick(t);
  const main = el('button', 'main');
  main.style.textAlign = 'left';
  main.append(el('div', 't', e.title));
  const m = el('div', 'm');
  m.append(el('span', 0, `${clock(toM(e.start))}–${clock(toM(e.end))}`), el('span', 0, dur(toM(e.end) - toM(e.start))));
  if (t?.due) m.append(el('span', t.due < logicalToday() ? 'ng' : '', `期限 ${label(t.due)}`));
  if (+t?.priority === 3) m.append(el('span', 'ng', '優先度 高'));
  main.append(m);
  main.onclick = () => openEvent(e.id);
  b.append(chk, main);
  return b;
}
/** 1日の画面の「この日のToDo」 */
function renderDayTodos(date) {
  const box = $('#dtodo');
  const raw = events();
  const rawById = new Map(raw.map((e) => [e.id, e]));
  const L = todoBlocks().filter((e) => e.date === date).sort((a, b) => toM(a.start) - toM(b.start));
  box.innerHTML = '';
  if (!L.length) { box.hidden = true; return; }
  box.hidden = false;
  const total = L.reduce((a, e) => a + toM(e.end) - toM(e.start), 0);
  const doneN = L.filter((e) => store.get('todo', e.ref)?.done).length;
  box.append(el('div', 'sect', `この日のToDo　${L.length}件・合計${dur(total)}${doneN ? `（うち${doneN}件完了）` : ''}`));
  const l = el('div', 'list');
  L.forEach((e) => l.append(blockRow(e, rawById)));
  box.append(l);
}

let todoView = 'list';
try { todoView = localStorage.getItem('sched-todoview') === 'day' ? 'day' : 'list'; } catch {}
/** ToDo タブの「日ごと」：入っている日ごとにまとめる。どの日にも入っていないものは最後に */
function renderTodosByDay(wrap, open, row) {
  const today = logicalToday();
  const raw = events();
  const rawById = new Map(raw.map((e) => [e.id, e]));
  const openIds = new Set(open.map((t) => t.id));
  const blocks = todoBlocks().filter((e) => e.date >= today && openIds.has(e.ref)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const byDate = new Map();
  for (const e of blocks) byDate.set(e.date, [...(byDate.get(e.date) || []), e]);
  const placedIds = new Set(blocks.map((e) => e.ref));
  for (const [d, list] of byDate) {
    const total = list.reduce((a, e) => a + toM(e.end) - toM(e.start), 0);
    const diff = Math.round((pd(d) - pd(today)) / 864e5);
    wrap.append(el('div', 'sect', `${diff === 0 ? '今日' : diff === 1 ? '明日' : ''} ${label(d)}　${list.length}件・${dur(total)}`.trim()));
    const l = el('div', 'list');
    list.forEach((e) => l.append(blockRow(e, rawById)));
    wrap.append(l);
  }
  const rest = open.filter((t) => !placedIds.has(t.id));
  if (rest.length) {
    wrap.append(el('div', 'sect', 'まだどの日にも入っていない'));
    const l = el('div', 'list');
    rest.forEach((t, i) => l.append(row(t, i)));
    wrap.append(l);
  }
  if (!byDate.size && !rest.length) wrap.append(el('div', 'empty', '未完了の ToDo はありません'));
}

function renderTodos() {
  $('#todo-view').querySelectorAll('.tg').forEach((b) => b.classList.toggle('on', b.dataset.v === todoView));
  $('#todo-hint').textContent = ai.aiAvailable()
    ? '✨ 追加すると AI が所要時間を見積もり、今後1週間の空き時間に自動で割り振ります。'
    : '追加すると所要時間を見積もり（ログインすると AI 見積もり）、今後1週間の空き時間に自動で割り振ります。';
  let list = store.all('todo');
  const manual = S().todoOrder !== 'due';
  const templates = list.filter((t) => t.template);
  list = list.filter((t) => !t.template); // くり返しの雛形は普段の一覧に出さない
  const open = list.filter((t) => !t.done).sort(todoCompare(S()));
  const doneAll = list.filter((t) => t.done).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
  const done = doneAll.slice(0, 30);
  const wrap = $('#todo-list');
  wrap.innerHTML = '';
  if (!list.length && !templates.length) { wrap.append(el('div', 'empty', 'ToDo はまだありません')); return; }
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
    if (t.series) m.append(el('span', 'pill', '🔁 くり返し'));
    if (t.start && t.start > ymd(new Date())) m.append(el('span', 0, `${label(t.start)}に出ます`));
    if (+t.priority === 3) m.append(el('span', 'ng', '優先度 高'));
    if (hasConstraint(t) || t.prefer) m.append(el('span', 'pill', describe(t)));
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
  if (todoView === 'day') renderTodosByDay(wrap, open, row);
  else {
    if (open.length) wrap.append(el('div', 'sect', manual ? '割り振りの順番（上から先に空きへ入れます）' : '割り振りの順番：期限が近い順（設定で手動に変更できます）'));
    const l1 = el('div', 'list');
    open.forEach((t, i) => l1.append(row(t, i)));
    wrap.append(l1);
  }
  if (templates.length) {
    wrap.append(el('div', 'sect', 'くり返しの ToDo（設定した曜日に、自動で1件ずつ出ます）'));
    const lt = el('div', 'list');
    for (const t of templates) {
      const b = el('button', 'card item');
      const main = el('div', 'main');
      main.append(el('div', 't', '🔁 ' + t.title));
      const m = el('div', 'm');
      m.append(el('span', 0, describeTodoRepeat(t.repeat, WD)));
      if (t.minutes) m.append(el('span', 0, `約${dur(+t.minutes)}`));
      if (hasConstraint(t)) m.append(el('span', 'pill', describe(t)));
      main.append(m);
      b.append(main);
      b.onclick = () => openTodo(t.id);
      lt.append(b);
    }
    wrap.append(lt);
  }
  if (doneAll.length) {
    // 完了済みは普段は隠す。開いたときだけ一覧とまとめて削除を出す
    const tg = el('button', 'ghost donetg', `完了済み ${doneAll.length}件 ${showDone ? '▲' : '▼'}`);
    tg.onclick = () => { showDone = !showDone; render(); };
    wrap.append(tg);
    if (showDone) {
      const l2 = el('div', 'list');
      done.forEach((t) => l2.append(row(t)));
      wrap.append(l2);
      const clr = el('button', 'ghost donetg', '完了済みをすべて削除');
      clr.onclick = () => { if (confirm(`完了済みの ${doneAll.length} 件を削除しますか？`)) { store.batch(({ remove }) => doneAll.forEach((t) => remove('todo', t.id))); showDone = false; toast('削除しました'); } };
      wrap.append(clr);
    }
  }
}

let showDone = false;
/** くり返しの雛形から、今日〜配置期間に出る回の ToDo を作る（すでにある・削除した回は作り直さない）。
 *  作成時刻を「出た日の0時」にして、別の端末で編集・完了した内容を上書きしないようにする */
function spawnRepeatTodos() {
  const t0 = logicalToday();
  const last = addDays(t0, Math.max(1, Math.min(28, +S().horizon || 7)));
  const made = [];
  for (const tpl of store.all('todo').filter(isTodoTemplate)) {
    for (const inst of repeatTodoInstances(tpl, t0, last)) if (!store.exists('todo', inst.id)) made.push(inst);
  }
  if (made.length) store.batch(({ put }) => made.forEach((x) => put('todo', x, { updatedAt: new Date(x.start + 'T00:00:00Z').toISOString() })));
}
/** 完了してから設定の日数がたった ToDo を削除する（元の ToDo が消えると、その作業枠も自動で消える） */
function purgeDoneTodos() {
  const keep = S().doneKeepDays;
  if (String(keep) === 'never') return;
  const cutoff = Date.now() - Math.max(0, Number(keep ?? 3)) * 864e5;
  const old = store.all('todo').filter((t) => t.done && (!t.doneAt || new Date(t.doneAt).getTime() < cutoff));
  if (old.length) store.batch(({ remove }) => old.forEach((t) => remove('todo', t.id)));
}

/** open（表示順）の idx 番目を dir(-1/+1) だけ動かす。全件に連番を振り直してから入れ替える */
function moveTodo(open, idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= open.length) return;
  freshNext = true;
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
$('#todo-view').onclick = (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  todoView = b.dataset.v;
  try { localStorage.setItem('sched-todoview', todoView); } catch {}
  render();
};
$('#replan').onclick = () => { replan(new Date(), true); render(); toast('並び順どおりに割り振り直しました'); };

function openTodo(id) {
  const t = store.get('todo', id);
  if (!t) return;
  const pl = placementOf(id);
  const tRepDays = new Set(t.repeat?.days || []);
  openSheet(`<form id="form"><h3>${t.template ? 'くり返しの ToDo' : 'ToDo'}</h3>
    <label>タイトル</label><input type="text" id="t-title" required value="${esc(t.title)}">
    <div class="row">
      <div><label>所要時間（分）</label><input type="number" id="t-min" min="5" max="600" step="5" value="${+t.minutes || ''}"></div>
      <div><label>期限</label><input type="date" id="t-due" value="${esc(t.due)}"></div>
    </div>
    ${t.estReason ? `<p class="note">${t.estSource === 'ai' ? '✨ AI' : '目安'}：${esc(t.estReason)}</p>` : ''}
    <div class="row" style="margin-top:6px;flex-wrap:wrap"><button type="button" class="ghost" id="t-ai">✨ 所要時間を見積もり直す</button><button type="button" class="ghost" id="t-habit">🔁 習慣にする</button></div>
    <label>優先度</label><div class="toggles" id="t-pri">${[3, 2, 1].map((p) => `<button type="button" class="tg ${(+t.priority || 2) === p ? 'on' : ''}" data-p="${p}">${PRI[p]}</button>`).join('')}</div>
    ${constraintFields(t)}
    ${t.series ? `<p class="note">🔁 くり返しの課題の1回分です。出た日：${esc(t.start || '')}${store.get('todo', t.series) ? '' : '（くり返しの設定は削除されています）'}</p>${store.get('todo', t.series) ? '<button type="button" class="ghost" id="t-openseries">くり返しの設定を開く</button>' : ''}` : `
    <label>くり返し（課題が毎週出る、など。曜日を選ぶと、その曜日に新しい ToDo が自動で出ます）</label>
    <div class="toggles" id="t-rep">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" class="tg ${tRepDays.has(d) ? 'on' : ''}" data-d="${d}">${WD[d]}</button>`).join('')}</div>
    <div id="t-rep-opts" ${tRepDays.size ? '' : 'hidden'}>
      <label>期限</label>
      <select id="t-dueafter">${Array.from({ length: 15 }, (_, i) => `<option value="${i}" ${(+t.repeat?.dueAfter || 0) === i ? 'selected' : ''}>${i ? `出た日の${i}日後まで` : '出た日のうちに'}</option>`).join('')}</select>
      <label>間隔</label>
      <select id="t-every">${[[1, '毎週'], [2, '隔週（2週に1回）'], [3, '3週ごと'], [4, '4週ごと']].map(([v, l]) => `<option value="${v}" ${(+t.repeat?.every || 1) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label>いつまで（空欄なら続きます）</label><input type="date" id="t-until" value="${esc(t.repeat?.until)}">
      <p class="note">やる時間は決めず、出た日〜期限のあいだの空きに自動で入れます。${t.template ? '' : 'この ToDo は「くり返しの雛形」になります（今日出ている分があれば、そのぶんの ToDo が作られます）。'}</p>
    </div>`}
    <label>メモ</label><textarea id="t-memo" rows="2">${esc(t.memo)}</textarea>
    ${pl.length ? `<p class="note">配置：${pl.map((e) => `${label(e.date)} ${e.start}–${e.end}`).join('、')}</p>` : ''}
    <div class="acts"><button type="button" class="del" id="t-del">削除</button><button type="button" id="t-cancel">閉じる</button><button type="submit" class="pri">保存</button></div>
  </form>`, (p) => {
    const getC = bindConstraints(p, t);
    p.querySelectorAll('#t-rep .tg').forEach((b) => (b.onclick = () => {
      const d = +b.dataset.d;
      tRepDays.has(d) ? tRepDays.delete(d) : tRepDays.add(d);
      b.classList.toggle('on', tRepDays.has(d));
      $('#t-rep-opts', p).hidden = !tRepDays.size;
    }));
    const os = $('#t-openseries', p);
    if (os) os.onclick = () => { closeSheet(); openTodo(t.series); };
    let pri = +t.priority || 2;
    p.querySelectorAll('#t-pri .tg').forEach((b) => (b.onclick = () => { pri = +b.dataset.p; p.querySelectorAll('#t-pri .tg').forEach((x) => x.classList.toggle('on', x === b)); }));
    $('#t-cancel', p).onclick = closeSheet;
    $('#t-habit', p).onclick = () => {
      const c = getC(), minutes = Math.max(5, Math.round((+$('#t-min', p).value || +t.minutes || 30) / 5) * 5);
      closeSheet();
      openHabit(null, { title: $('#t-title', p).value.trim() || t.title, minutes, places: c.places, after: c.after, notBefore: c.notBefore, notAfter: c.notAfter, prefer: c.prefer, color: HABIT_COLOR }, t.id);
    };
    $('#t-del', p).onclick = () => { if (confirm(t.template ? 'くり返しの設定を削除しますか？（これから出る分は無くなります。すでに出た ToDo はそのまま残ります）' : 'この ToDo を削除しますか？')) { store.remove('todo', id); closeSheet(); } };
    $('#t-ai', p).onclick = () => { closeSheet(); estimateTodos([{ ...t, title: $('#t-title', p).value.trim() || t.title }]); };
    $('#form', p).onsubmit = (e) => {
      e.preventDefault();
      freshNext = true;
      const minutes = Math.max(0, Math.round((+$('#t-min', p).value || 0) / 5) * 5);
      const base = { ...t, title: $('#t-title', p).value.trim(), minutes, due: $('#t-due', p).value, priority: pri, memo: $('#t-memo', p).value, ...getC(), ...(minutes !== +t.minutes ? { estSource: 'manual', estReason: '' } : {}) };
      if (!t.series && tRepDays.size) {
        // くり返しの雛形にする（この ToDo 自体は配置されなくなり、回ごとの ToDo が出る）
        const days = [...tRepDays], every = +$('#t-every', p).value || 1, dueAfter = +$('#t-dueafter', p).value || 0;
        const same = t.template && t.repeat && t.repeat.every === every && [...(t.repeat.days || [])].sort().join() === [...days].sort().join();
        const repeat = { days, every, dueAfter, until: $('#t-until', p).value || '', count: 0, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
        const date = same ? t.date : nextMatching(addDays(logicalToday(), -dueAfter), days); // 今出ている（期限が今日以降の）回も拾う
        store.put('todo', { ...base, template: true, repeat, date, done: false, due: '', start: '' });
        spawnRepeatTodos();
        toast('くり返しの ToDo にしました');
      } else if (t.template && !tRepDays.size) {
        store.put('todo', { ...base, template: false, repeat: null, date: '' }); // くり返しをやめて、ふつうの ToDo に戻す
      } else store.put('todo', base);
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
    m.append(el('span', 0, +h.perWeek > 0 ? `週${Math.round(+h.perWeek)}回${days.length === 7 ? '' : '（' + days.map((d) => WD[d]).join('・') + 'のどこか）'}` : days.length === 7 ? '毎日' : days.length ? days.map((d) => WD[d]).join('・') : '曜日なし'));
    m.append(el('span', 0, h.anytime ? `${dur(+h.minutes || 30)}をその日のどこかに` : `${h.from}–${h.to} の間に ${dur(+h.minutes || 30)}`));
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

/** 習慣の追加・編集。prefill は ToDo から習慣にするときの初期値、fromTodo は保存後に消す元の ToDo */
function openHabit(id, prefill, fromTodo) {
  const h = id ? store.get('habit', id) : null;
  const cur = h || { title: '', days: [0, 1, 2, 3, 4, 5, 6], from: '06:00', to: '09:00', minutes: 30, color: HABIT_COLOR, anytime: true, ...(prefill || {}) };
  const order = [1, 2, 3, 4, 5, 6, 0];
  const weekly = Math.round(+cur.perWeek || 0);
  openSheet(`<form id="form"><h3>${h ? '習慣を編集' : fromTodo ? 'ToDo を習慣にする' : '習慣を追加'}</h3>
    <label>タイトル</label><input type="text" id="h-title" required value="${esc(cur.title)}" placeholder="例：ランニング">
    <label>頻度</label>
    <div class="toggles" id="h-freq"><button type="button" class="tg ${weekly ? '' : 'on'}" data-v="0">決めた曜日に</button><button type="button" class="tg ${weekly ? 'on' : ''}" data-v="1">週に決めた回数（曜日は自由）</button></div>
    <div id="h-pw" ${weekly ? '' : 'hidden'} style="margin-top:8px"><div class="row" style="align-items:center"><div style="flex:none;width:90px"><input type="number" id="h-pwn" min="1" max="7" step="1" value="${weekly || 3}"></div><div>回（月曜〜日曜で数えます）</div></div></div>
    <label id="h-dayslabel">${weekly ? '使える曜日（このうち、週の回数ぶん）' : '曜日'}</label><div class="toggles" id="h-days">${order.map((d) => `<button type="button" class="tg ${cur.days.includes(d) ? 'on' : ''}" data-d="${d}">${WD[d]}</button>`).join('')}</div>
    <label>時間帯</label>
    <div class="toggles" id="h-any"><button type="button" class="tg ${cur.anytime ? 'on' : ''}" data-v="1">指定しない（その日のどこか）</button><button type="button" class="tg ${cur.anytime ? '' : 'on'}" data-v="0">時間帯を決める</button></div>
    <div class="row" id="h-win" ${cur.anytime ? 'hidden' : ''} style="margin-top:8px"><div><input type="time" id="h-from" value="${cur.from}"></div><div><input type="time" id="h-to" value="${cur.to}"></div></div>
    <p class="note" id="h-anynote" ${cur.anytime ? '' : 'hidden'}>毎日同じ時間にはなりません。その日の空きのどこかに、ちょうど収まる隙間を選んで入れます。</p>
    <label>所要時間（分）</label><input type="number" id="h-min" min="5" max="600" step="5" value="${+cur.minutes || 30}" required>
    ${constraintFields(cur)}
    <label>色</label>${colorPicker(cur.color, [HABIT_COLOR, cur.color])}
    <div class="acts">${h ? '<button type="button" class="del" id="h-del">削除</button>' : ''}<button type="button" id="h-cancel">閉じる</button><button type="submit" class="pri">保存</button></div>
  </form>`, (p) => {
    const getC = bindConstraints(p, cur);
    let isWeekly = !!weekly;
    p.querySelectorAll('#h-freq .tg').forEach((b) => (b.onclick = () => {
      isWeekly = b.dataset.v === '1';
      p.querySelectorAll('#h-freq .tg').forEach((x) => x.classList.toggle('on', x === b));
      $('#h-pw', p).hidden = !isWeekly;
      $('#h-dayslabel', p).textContent = isWeekly ? '使える曜日（このうち、週の回数ぶん）' : '曜日';
    }));
    let anytime = !!cur.anytime;
    p.querySelectorAll('#h-any .tg').forEach((b) => (b.onclick = () => {
      anytime = b.dataset.v === '1';
      p.querySelectorAll('#h-any .tg').forEach((x) => x.classList.toggle('on', x === b));
      $('#h-win', p).hidden = anytime; $('#h-anynote', p).hidden = !anytime;
    }));
    const days = new Set(cur.days);
    p.querySelectorAll('#h-days .tg').forEach((b) => (b.onclick = () => { const d = +b.dataset.d; days.has(d) ? days.delete(d) : days.add(d); b.classList.toggle('on', days.has(d)); }));
    $('#h-cancel', p).onclick = closeSheet;
    if (h) $('#h-del', p).onclick = () => { if (confirm('この習慣を削除しますか？（今後の枠も消えます）')) { store.remove('habit', id); closeSheet(); } };
    $('#form', p).onsubmit = (e) => {
      e.preventDefault();
      const from = $('#h-from', p).value || '06:00', to = $('#h-to', p).value || '09:00', minutes = +$('#h-min', p).value;
      if (!anytime && toM(to) - toM(from) < minutes) return toast('時間帯が所要時間より短いです');
      if (!days.size) return toast('曜日を1つ以上選んでください');
      const perWeek = isWeekly ? Math.max(1, Math.min(7, Math.round(+$('#h-pwn', p).value || 1))) : 0;
      if (perWeek && days.size < perWeek) return toast('使える曜日が、週の回数より少ないです');
      store.put('habit', { ...(h || { id: uid(), skip: [] }), title: $('#h-title', p).value.trim(), days: [...days], from, to, anytime, perWeek, minutes, ...getC(), color: $('input[name=c]:checked', p)?.value || HABIT_COLOR });
      if (fromTodo) { store.remove('todo', fromTodo); freshNext = true; toast('習慣にしました（元の ToDo は消しました）'); }
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
    <div class="srow"><span>終了${toM(s.dayEnd) <= toM(s.dayStart) ? '（翌日）' : ''}<small>開始より前の時刻（例 02:00）にすると、翌日の深夜までになります</small></span><input type="time" data-k="dayEnd" value="${s.dayEnd}"></div>
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
    <div class="srow"><span>ToDo を入れる隙間<small>優先度は「空きが足りないとき、誰が先に枠を取るか」にだけ使います。時間の早い遅いは決めません</small></span><select data-k="placeStyle"><option value="fit">ちょうど収まる隙間</option><option value="early">早い時間から詰める</option></select></div>
    <div class="srow"><span>ToDo を入れる順番<small>手動：ToDo 画面の ▲▼ で並べた順</small></span><select data-k="todoOrder"><option value="manual">手動の順番</option><option value="due">期限が近い順</option></select></div>
    <div class="srow"><span>完了した ToDo を自動で消す<small>完了してから、この日数がたったら削除します</small></span><select data-k="doneKeepDays"><option value="1">1日後</option><option value="3">3日後</option><option value="7">7日後</option><option value="30">30日後</option><option value="never">消さない</option></select></div>
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
    <h2>移動</h2>
    <p class="hint" style="margin-top:4px">場所が変わる予定のあいだに、ここで決めた時間だけ「移動」を確保します（最初の予定の前と、最後の予定のあとは、ふだんいる場所との行き来）。行きも帰りも同じです。</p>
    ${(s.routes || []).map((r, i) => `<div class="srow"><span>${esc(r.from)} ⇔ ${esc(r.to)}<small>${r.from}→${r.to}：${r.minutes}分${r.mode ? '・' + esc(r.mode) : ''}${r.backMinutes || r.backMode ? `／帰り：${r.backMinutes || r.minutes}分${(r.backMode || r.mode) ? '・' + esc(r.backMode || r.mode) : ''}` : ''}</small></span><button class="ghost" data-rd="${i}" aria-label="ルートを削除">削除</button></div>`).join('')}
    <div class="row" style="padding:8px 0 0"><div><select id="r-from">${(s.places || []).map((p) => `<option>${esc(p.name)}</option>`).join('')}</select></div><div><select id="r-to">${(s.places || []).map((p, i) => `<option ${i === 1 ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div></div>
    <div class="row" style="padding:8px 0 10px"><div><input type="number" id="r-min" min="5" max="300" step="5" value="30" aria-label="移動時間（分）"></div><div><select id="r-mode"><option value="">手段なし</option>${(s.modes || []).map((m) => `<option>${esc(m.name)}</option>`).join('')}</select></div></div>
    <div class="row" style="padding:0 0 10px"><div><input type="number" id="r-bmin" min="5" max="300" step="5" placeholder="帰りの分（空=同じ）" aria-label="帰りの移動時間（分）"></div><div><select id="r-bmode"><option value="">帰りも同じ手段</option>${(s.modes || []).map((m) => `<option>${esc(m.name)}</option>`).join('')}</select></div><div style="flex:none"><button class="pri" id="route-add">追加</button></div></div>
    <h2>移動手段</h2>
    ${(s.modes || []).map((m, i) => `<div class="srow"><span>${esc(m.name)}</span><label class="chk"><input type="checkbox" data-mw="${i}" ${m.work ? 'checked' : ''}> 作業できる</label><button class="ghost" data-md="${i}" aria-label="${esc(m.name)}を削除">削除</button></div>`).join('')}
    <div class="srow"><input type="text" class="wide" id="mode-new" placeholder="手段を追加（例：タクシー）" maxlength="10"><button class="pri" id="mode-add">追加</button></div>
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
  box.querySelector('select[data-k=placeStyle]').value = s.placeStyle === 'early' ? 'early' : 'fit';
  box.querySelector('select[data-k=doneKeepDays]').value = String(s.doneKeepDays ?? '3');
  box.querySelectorAll('[data-pt]').forEach((c) => (c.onchange = () => store.setSettings({ places: S().places.map((p, i) => (i === +c.dataset.pt ? { ...p, transit: c.checked } : p)) })));
  box.querySelectorAll('[data-pd]').forEach((b) => (b.onclick = () => {
    const p = S().places[+b.dataset.pd];
    if (!confirm(`「${p.name}」を削除しますか？（この場所を指定した予定・ToDo の条件は効かなくなります）`)) return;
    const places = S().places.filter((_, i) => i !== +b.dataset.pd);
    store.setSettings({ places, ...(S().home === p.name ? { home: places[0]?.name || '' } : {}) });
  }));
  box.querySelectorAll('[data-rd]').forEach((b) => (b.onclick = () => store.setSettings({ routes: S().routes.filter((_, i) => i !== +b.dataset.rd) })));
  $('#route-add').onclick = () => {
    const from = $('#r-from').value, to = $('#r-to').value, minutes = Math.round(+$('#r-min').value);
    if (!from || !to || from === to) return toast('出発と到着は別の場所にしてください');
    if (!(minutes > 0)) return toast('移動時間を入れてください');
    if (S().routes.some((r) => (r.from === from && r.to === to) || (r.from === to && r.to === from))) return toast('そのルートはもうあります（削除して入れ直してください）');
    document.activeElement?.blur?.();
    freshNext = true;
    const bm = Math.round(+$('#r-bmin').value);
    store.setSettings({ routes: [...S().routes, { from, to, minutes, mode: $('#r-mode').value, backMinutes: bm > 0 ? bm : null, backMode: $('#r-bmode').value }] });
  };
  box.querySelectorAll('[data-mw]').forEach((c) => (c.onchange = () => store.setSettings({ modes: S().modes.map((m, i) => (i === +c.dataset.mw ? { ...m, work: c.checked } : m)) })));
  box.querySelectorAll('[data-md]').forEach((b) => (b.onclick = () => {
    const m = S().modes[+b.dataset.md];
    if (confirm(`「${m.name}」を削除しますか？（この手段を使うルートは手段なしになります）`)) store.setSettings({ modes: S().modes.filter((_, i) => i !== +b.dataset.md), routes: S().routes.map((r) => (r.mode === m.name ? { ...r, mode: '' } : r)) });
  }));
  $('#mode-add').onclick = () => {
    const name = $('#mode-new').value.trim();
    if (!name) return;
    if (S().modes.some((m) => m.name === name) || S().places.some((p) => p.name === name)) return toast('同じ名前があります');
    document.activeElement?.blur?.();
    store.setSettings({ modes: [...S().modes, { name, work: false }] });
  };
  $('#place-add').onclick = () => {
    const name = $('#place-new').value.trim();
    if (!name) return;
    if (S().places.some((p) => p.name === name)) return toast('同じ名前の場所があります');
    document.activeElement?.blur?.();
    store.setSettings({ places: [...S().places, { name, transit: false }] });
  };
  box.querySelectorAll('[data-k]').forEach((inp) => {
    const commit = () => {
    const k = inp.dataset.k;
    let v = inp.value;
    if (String(v) === String(S()[k])) return; // 変更なし
    if (inp.type === 'number') v = Math.max(+inp.min || 0, Math.min(+inp.max || 999, Math.round(+v || 0)));
    let extra = {};
    if (k === 'dayStart' || k === 'dayEnd') {
      const a = k === 'dayStart' ? v : S().dayStart, b = k === 'dayEnd' ? v : S().dayEnd;
      if (!v) { inp.value = S()[k]; return; }
      extra = { dayEndNext: toM(b) <= toM(a) }; // 終了が開始以前なら翌日まで
      freshNext = true;
    }
    if (k === 'todoOrder' || k === 'constrainedFirst' || k === 'placeStyle') freshNext = true;
    store.setSettings({ [k]: v, ...extra });
    if (k === 'theme') applyTheme();
    };
    if (inp.type === 'time') {
      // iPhone のピッカーは回している途中でも change が来る。閉じた（フォーカスが外れた）ときだけ保存する
      inp.addEventListener('change', () => { if (document.activeElement !== inp) commit(); });
      inp.addEventListener('blur', commit);
    } else inp.onchange = commit;
  });
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
$('#settings').addEventListener('focusout', () => setTimeout(() => { if (tab === 'settings' && !sheetOpen) render(); }, 80));
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
$('#today').onclick = () => { sel = logicalToday(); render(); };
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

store.onChange((src) => {
  if (src === 'remote') spawnRepeatTodos(); // 別の端末で雛形を作った/変えたときも、この端末で回を出す
  applyTheme();
  scheduleReplan();
  push.scheduleLocal(events(), S());
});
sync.onStatus(() => { if (tab === 'settings' && !sheetOpen) render(); });

// 1分ごとに「今」を更新し、日付が変わったら配置し直す
let lastDay = logicalToday();
setInterval(() => {
  const d = logicalToday();
  if (d !== lastDay) { if (sel === lastDay) sel = d; lastDay = d; purgeDoneTodos(); spawnRepeatTodos(); replan(); }
  if (!sheetOpen && tab === 'day') render();
}, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { purgeDoneTodos(); spawnRepeatTodos(); replan(); if (!sheetOpen) render(); } });

// ---------------------------------------------------------------- 起動
if ('serviceWorker' in navigator) {
  // 新しい版の Service Worker に切り替わったら、自動で読み込み直す（初回インストール時は除く）
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded && !sheetOpen) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.date) { sel = e.data.date; setTab('day'); }
  });
}
applyTheme();
purgeDoneTodos();
spawnRepeatTodos();
replan();
setTab(tab);
push.scheduleLocal(events(), S());
sync.init().then(() => { if (!sheetOpen) render(); });

