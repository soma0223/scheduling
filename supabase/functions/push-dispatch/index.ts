// 毎分 pg_cron から呼ばれ、通知タイミングが来た予定を Web Push で送る Edge Function
// 必要な secrets: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT(mailto:...)
// デプロイ: supabase functions deploy push-dispatch --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';
import { recurringInstances } from './time.ts';

const CATCH_UP_MS = 3 * 60 * 1000; // cron が遅れても3分以内なら送る

type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return new Response('unauthorized', { status: 401 });
  }
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  webpush.setVapidDetails(
    Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com',
    Deno.env.get('VAPID_PUBLIC_KEY')!,
    Deno.env.get('VAPID_PRIVATE_KEY')!,
  );

  const now = Date.now();

  // 1. 通知を受け取る端末があるユーザー
  const { data: subs, error: e1 } = await sb.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth');
  if (e1) return new Response(e1.message, { status: 500 });
  if (!subs?.length) return Response.json({ sent: 0 });
  const subsByUser = new Map<string, Sub[]>();
  for (const s of subs as Sub[]) subsByUser.set(s.user_id, [...(subsByUser.get(s.user_id) ?? []), s]);
  const users = [...subsByUser.keys()];

  // 2. 各ユーザーの通知タイミング（何分前）
  const { data: settings } = await sb.from('records').select('user_id,data')
    .eq('kind', 'settings').in('user_id', users);
  const offsets = new Map<string, number[]>();
  for (const u of users) offsets.set(u, [10]);
  for (const r of settings ?? []) {
    const n = (r.data?.notify ?? []).map(Number).filter((x: number) => Number.isFinite(x) && x >= 0 && x <= 1440);
    offsets.set(r.user_id, n);
  }
  const maxOff = Math.max(0, ...[...offsets.values()].flat());

  // 3. これから始まる予定（単発）と、曜日で繰り返す予定の「回」
  const loMs = now - CATCH_UP_MS, hiMs = now + (maxOff + 1) * 60000;
  const { data: once, error: e2 } = await sb.from('records').select('user_id,id,data,starts_at')
    .eq('kind', 'event').eq('deleted', false).in('user_id', users)
    .gte('starts_at', new Date(loMs).toISOString())
    .lte('starts_at', new Date(hiMs).toISOString());
  if (e2) return new Response(e2.message, { status: 500 });
  const { data: masters, error: e3 } = await sb.from('records').select('user_id,id,data')
    .eq('kind', 'event').eq('deleted', false).in('user_id', users).contains('data', { repeat: {} });
  if (e3) return new Response(e3.message, { status: 500 });
  // 繰り返しの親の starts_at は最初の回のもの。二重に通知しないよう単発側から外し、回として数え直す
  const events = [
    ...(once ?? []).filter((r) => !r.data?.repeat?.days?.length),
    ...recurringInstances(masters ?? [], now, loMs, hiMs),
  ];

  let sent = 0;
  const gone: string[] = [];
  for (const ev of events) {
    const start = new Date(ev.starts_at).getTime();
    for (const off of offsets.get(ev.user_id) ?? []) {
      const fireAt = start - off * 60000;
      if (fireAt > now || fireAt <= now - CATCH_UP_MS) continue;

      // 重複防止：記録できたときだけ送る
      const { data: claimed, error } = await sb.from('push_log')
        .upsert({ user_id: ev.user_id, event_id: ev.id, offset_min: off, starts_at: ev.starts_at },
          { onConflict: 'user_id,event_id,offset_min,starts_at', ignoreDuplicates: true })
        .select();
      if (error || !claimed?.length) continue;

      const d = ev.data ?? {};
      const payload = JSON.stringify({
        title: d.title || '予定',
        body: `${off ? `${off}分後に開始` : 'まもなく開始'}（${d.start}–${d.end}）`,
        tag: `${ev.id}-${off}`,
        date: d.date,
        url: `./?tab=day&date=${d.date}`,
      });
      for (const s of subsByUser.get(ev.user_id) ?? []) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            { TTL: 600, urgency: 'high' },
          );
          sent++;
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) gone.push(s.id); // 購読が切れた端末
          else console.error('push failed', code, (err as Error).message);
        }
      }
    }
  }
  if (gone.length) await sb.from('push_subscriptions').delete().in('id', gone);

  // 古い送信記録の掃除
  await sb.from('push_log').delete().lt('sent_at', new Date(now - 7 * 864e5).toISOString());

  return Response.json({ sent, removed: gone.length });
});
