// 通知
//  1) Web Push（Supabase + VAPID）: アプリを閉じていても届く。サーバーが毎分チェックして送る
//  2) ローカル通知: Web Push が使えないときのフォールバック。アプリを開いている間だけ有効

import config from '../config.js';
import * as sync from './sync.js';
import { toISO } from './util.js';

export const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const permission = () => ('Notification' in window ? Notification.permission : 'unsupported');
export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export async function currentSubscription() {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Web Push を有効化し、購読情報をサーバーに保存 */
export async function enable() {
  if (!supported()) throw new Error(isIOS() && !isStandalone()
    ? 'iPhone では「ホーム画面に追加」したアプリから有効にしてください'
    : 'このブラウザは Web Push に対応していません');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知が許可されませんでした');
  const sb = sync.client(), user = sync.currentUser();
  if (!sb || !user || !config.vapidPublicKey) return 'local'; // ローカル通知のみ
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(config.vapidPublicKey) });
  }
  const j = sub.toJSON();
  const { error } = await sb.from('push_subscriptions').upsert({
    user_id: user.id,
    endpoint: j.endpoint,
    p256dh: j.keys.p256dh,
    auth: j.keys.auth,
    user_agent: navigator.userAgent.slice(0, 200),
  }, { onConflict: 'endpoint' });
  if (error) throw error;
  return 'push';
}

export async function disable() {
  const sub = await currentSubscription();
  if (!sub) return;
  const sb = sync.client();
  if (sb) await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
}

export async function test() {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('テスト通知', { body: '通知はこのように表示されます', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: 'test' });
}

// ---- ローカル通知（アプリを開いている間） ----
let timers = [];
export async function scheduleLocal(events, settings) {
  timers.forEach(clearTimeout);
  timers = [];
  if (permission() !== 'granted' || !('serviceWorker' in navigator)) return;
  // サーバー Push が有効なら二重通知しない
  if (sync.currentUser() && config.vapidPublicKey && (await currentSubscription())) return;
  const now = Date.now(), until = now + 24 * 3600 * 1000;
  for (const e of events) {
    if (e.deleted || !e.start) continue;
    const t0 = new Date(toISO(e.date, e.start)).getTime();
    for (const off of settings.notify || []) {
      const at = t0 - off * 60000;
      if (at <= now || at > until) continue;
      timers.push(setTimeout(async () => {
        const reg = await navigator.serviceWorker.ready;
        reg.showNotification(e.title, {
          body: (off ? `${off}分後に開始` : 'まもなく開始') + `（${e.start}–${e.end}）`,
          tag: `${e.id}-${off}`,
          icon: 'icons/icon-192.png',
          badge: 'icons/badge-96.png',
          data: { url: `./?date=${e.date}` },
        });
      }, at - now));
    }
  }
}

