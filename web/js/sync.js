// Supabase による端末間同期（ローカルファースト）
//  - 起動時・変更時・復帰時・Realtime 通知時に push → pull
//  - サーバー側は records テーブル1つ（kind + jsonb）。updated_at が古い更新はトリガーで無視される
//  - ログインはメールの6桁コード（PWA 内で完結するようにマジックリンクは使わない）

import config from '../config.js';
import * as store from './store.js';
import { toISO } from './util.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

let sb = null;
let user = null;
let channel = null;
let busy = false;
let again = false;
let timer = null;
const statusListeners = new Set();
let status = { state: 'local', message: 'この端末のみ' };

export const enabled = () => !!(config.supabaseUrl && config.supabaseAnonKey);
export const client = () => sb;
export const currentUser = () => user;
export const getStatus = () => status;
export const onStatus = (fn) => (statusListeners.add(fn), fn(status), () => statusListeners.delete(fn));

function setStatus(state, message) {
  status = { state, message, at: new Date() };
  statusListeners.forEach((fn) => fn(status));
}

export async function init() {
  if (!enabled()) return;
  try {
    const { createClient } = await import(SUPABASE_ESM);
    sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  } catch (e) {
    setStatus('error', 'オフライン（同期ライブラリを読み込めません）');
    return;
  }
  const { data } = await sb.auth.getSession();
  await onUser(data.session?.user || null);
  sb.auth.onAuthStateChange((_ev, session) => {
    const u = session?.user || null;
    if ((u && u.id) !== (user && user.id)) onUser(u);
  });
  store.onChange((src) => { if (src === 'local') schedule(1500); });
  addEventListener('online', () => schedule(0));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
  setInterval(() => schedule(0), 5 * 60 * 1000);
}

async function onUser(u) {
  user = u;
  if (channel) { sb.removeChannel(channel); channel = null; }
  if (!u) { setStatus('signedout', '未ログイン（この端末のみ）'); return; }
  const m = store.meta();
  if (m.userId !== u.id) {
    // 初めて／別アカウントでログイン：手元のデータを全部送って、全部取り直す
    store.setMeta({ userId: u.id, lastPull: null });
    store.markAllDirty();
  }
  channel = sb
    .channel('records-' + u.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'records', filter: `user_id=eq.${u.id}` }, () => schedule(300))
    .subscribe();
  schedule(0);
}

export function schedule(ms) {
  if (!sb || !user) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}

export async function syncNow() {
  if (!sb || !user) return;
  if (busy) { again = true; return; }
  busy = true;
  setStatus('syncing', '同期中…');
  try {
    await pushDirty();
    await pull();
    setStatus('ok', '同期済み');
  } catch (e) {
    console.warn('sync failed', e);
    setStatus('error', navigator.onLine ? '同期エラー（再試行します）' : 'オフライン');
    clearTimeout(timer);
    timer = setTimeout(syncNow, 30000);
  } finally {
    busy = false;
    if (again) { again = false; schedule(0); }
  }
}

async function pushDirty() {
  const recs = store.dirtyRecords();
  for (let i = 0; i < recs.length; i += 200) {
    const chunk = recs.slice(i, i + 200);
    const sent = {};
    const rows = chunk.map(({ key, kind, id, data }) => {
      sent[key] = data.updatedAt;
      const { updatedAt, deleted, ...body } = data;
      return {
        user_id: user.id,
        id: kind === 'settings' ? 'settings' : id,
        kind,
        data: body,
        deleted: !!deleted,
        updated_at: updatedAt,
        starts_at: kind === 'event' && !deleted && body.date && body.start ? toISO(body.date, body.start) : null,
      };
    });
    const { error } = await sb.from('records').upsert(rows, { onConflict: 'user_id,id' });
    if (error) throw error;
    store.clearDirty(chunk.map((r) => r.key), sent);
  }
}

async function pull() {
  let since = store.meta().lastPull;
  for (;;) {
    let q = sb.from('records').select('id,kind,data,deleted,updated_at,server_updated_at')
      .order('server_updated_at', { ascending: true }).limit(1000);
    if (since) q = q.gt('server_updated_at', since);
    const { data, error } = await q;
    if (error) throw error;
    if (!data.length) break;
    store.applyRemote(data);
    since = data[data.length - 1].server_updated_at;
    store.setMeta({ lastPull: since });
    if (data.length < 1000) break;
  }
}

// ---- 認証 ----
export async function sendCode(email) {
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw error;
}
export async function verifyCode(email, token) {
  const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw error;
}
export async function signOut() {
  await sb.auth.signOut();
  store.setMeta({ userId: null, lastPull: null });
}
