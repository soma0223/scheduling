// ローカルファーストのデータストア（localStorage）。
// すべての変更は updatedAt 付きで記録し、dirty として同期待ちに積む。
// 同期は last-write-wins（updatedAt が新しい方を採用）。削除は論理削除（deleted=true）。

import { DEFAULT_SETTINGS } from './scheduler.js';
import { toM, fm } from './util.js';

const KEY = 'sched-pwa-v1';
const LEGACY_KEY = 'my-schedule-v1'; // 参考実装 schedule.html のデータ
export const KINDS = ['event', 'todo', 'habit'];

const blank = () => ({
  event: {},
  todo: {},
  habit: {},
  settings: { ...DEFAULT_SETTINGS, updatedAt: new Date(0).toISOString() },
  meta: { dirty: {}, lastPull: null, userId: null },
});

let db = load();
const listeners = new Set();

function load() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  if (!d) {
    d = blank();
    // 参考実装からの移行
    try {
      const old = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
      const now = new Date().toISOString();
      for (const e of old) {
        const start = e.start ?? e.time ?? '';
        const end = e.end ?? (start ? fm(Math.min(1439, toM(start) + 60)) : '');
        const x = { id: e.id, title: e.title, date: e.date, start, end, memo: e.memo || '', color: e.color, updatedAt: now };
        d.event[x.id] = x;
        d.meta.dirty['event:' + x.id] = 1;
      }
    } catch {}
  }
  const b = blank();
  for (const k of [...KINDS, 'meta']) d[k] = { ...b[k], ...(d[k] || {}) };
  d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  return d;
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {}
}

let emitTimer = null;
function emit(source) {
  persist();
  clearTimeout(emitTimer);
  emitTimer = setTimeout(() => listeners.forEach((fn) => fn(source)), 0);
}

export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));

/** 論理削除されていないレコード一覧 */
export const all = (kind) => Object.values(db[kind]).filter((x) => !x.deleted);
/** 論理削除も含む（スケジューラの差分用） */
export const raw = (kind) => Object.values(db[kind]);
export const get = (kind, id) => {
  const x = db[kind][id];
  return x && !x.deleted ? x : null;
};
/** 削除済みも含めて、そのレコードが（この端末に）あるか */
export const exists = (kind, id) => !!db[kind][id];
export const settings = () => db.settings;
export const meta = () => db.meta;

const stamp = () => new Date().toISOString();

export function put(kind, obj, { silent = false, updatedAt } = {}) {
  const prev = db[kind][obj.id] || {};
  const x = { ...prev, ...obj, deleted: false, updatedAt: updatedAt || stamp() };
  db[kind][x.id] = x;
  db.meta.dirty[kind + ':' + x.id] = 1;
  if (!silent) emit('local');
  return x;
}

export function remove(kind, id, { silent = false } = {}) {
  const prev = db[kind][id];
  if (!prev || prev.deleted) return;
  db[kind][id] = { id, deleted: true, updatedAt: stamp(), ...(kind === 'event' ? { date: prev.date } : {}) };
  db.meta.dirty[kind + ':' + id] = 1;
  if (!silent) emit('local');
}

/** まとめて書き込み（自動配置の結果など）→ 通知は1回 */
export function batch(fn) {
  fn({
    put: (k, o, opts) => put(k, o, { ...opts, silent: true }),
    remove: (k, id) => remove(k, id, { silent: true }),
  });
  emit('local');
}

export function setSettings(patch) {
  db.settings = { ...db.settings, ...patch, updatedAt: stamp() };
  db.meta.dirty['settings:settings'] = 1;
  emit('local');
}

export function setMeta(patch) {
  db.meta = { ...db.meta, ...patch };
  persist();
}

// ---- 同期用 ----

/** 未送信の変更を { kind, id, data } で返す */
export function dirtyRecords() {
  return Object.keys(db.meta.dirty).map((key) => {
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    const data = kind === 'settings' ? db.settings : db[kind][id];
    return { key, kind, id, data };
  }).filter((r) => r.data);
}

export function clearDirty(keys, sent) {
  // 送信中に再度変更されたものは dirty のまま残す
  for (const k of keys) {
    const [kind, ...rest] = k.split(':');
    const id = rest.join(':');
    const cur = kind === 'settings' ? db.settings : db[kind][id];
    if (!cur || cur.updatedAt === sent[k]) delete db.meta.dirty[k];
  }
  persist();
}

/** サーバーから来たレコードを LWW でマージ。変化があれば true */
export function applyRemote(rows) {
  let changed = false;
  for (const r of rows) {
    const data = { ...r.data, id: r.id, deleted: r.deleted, updatedAt: r.updated_at };
    if (r.kind === 'settings') {
      if (new Date(data.updatedAt) > new Date(db.settings.updatedAt)) {
        const { id, deleted, ...rest } = data;
        db.settings = { ...DEFAULT_SETTINGS, ...rest };
        changed = true;
      }
      continue;
    }
    if (!KINDS.includes(r.kind)) continue;
    const cur = db[r.kind][r.id];
    if (!cur || new Date(data.updatedAt) > new Date(cur.updatedAt)) {
      db[r.kind][r.id] = data;
      delete db.meta.dirty[r.kind + ':' + r.id];
      changed = true;
    }
  }
  if (changed) emit('remote');
  else persist();
  return changed;
}

/** 全レコードを再送信対象にする（別アカウントでログインし直したとき等） */
export function markAllDirty() {
  for (const k of KINDS) for (const id of Object.keys(db[k])) db.meta.dirty[k + ':' + id] = 1;
  db.meta.dirty['settings:settings'] = 1;
  persist();
}

export function exportJSON() {
  const { meta, ...rest } = db;
  return JSON.stringify(rest, null, 2);
}

export function importJSON(text) {
  const d = JSON.parse(text);
  batch(({ put }) => {
    for (const k of KINDS) for (const x of Object.values(d[k] || {})) if (!x.deleted) put(k, x);
  });
  if (d.settings) setSettings(d.settings);
}
