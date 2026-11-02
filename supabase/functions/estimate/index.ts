// ToDo の所要時間を Claude で見積もる Edge Function
// POST { items: [{ title, memo? }] } → { estimates: [{ minutes, reason }] }
// 認証必須（Supabase の JWT）。ANTHROPIC_API_KEY は `supabase secrets set` で設定する。

import Anthropic from 'npm:@anthropic-ai/sdk@0.136.0';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const client = new Anthropic(); // ANTHROPIC_API_KEY を環境変数から読む

const SYSTEM = `あなたは個人の予定管理アシスタントです。ToDo の各項目について、一般的な社会人が一人で集中して取り組んだ場合の現実的な所要時間（分）を見積もります。
- 5分単位。最小5分、最大600分
- 移動や準備が明らかに必要なもの（買い物・役所など）はそれも含める
- 曖昧なものは控えめすぎず、少し余裕をもたせる
- reason は日本語で20〜40文字程度、見積もりの根拠を簡潔に`;

const SCHEMA = {
  type: 'object',
  properties: {
    estimates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          minutes: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['minutes', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['estimates'],
  additionalProperties: false,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // ログイン中のユーザーだけ使える（API 代の不正利用防止）
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: 'unauthorized' }, 401);

  let items: { title: string; memo?: string }[] = [];
  try {
    const body = await req.json();
    items = (Array.isArray(body?.items) ? body.items : [])
      .slice(0, 30)
      .map((i: { title?: unknown; memo?: unknown }) => ({
        title: String(i?.title ?? '').slice(0, 200),
        memo: String(i?.memo ?? '').slice(0, 500),
      }));
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (!items.length) return json({ estimates: [] });

  const list = items
    .map((i, n) => `${n + 1}. ${i.title}${i.memo ? `（メモ: ${i.memo}）` : ''}`)
    .join('\n');

  try {
    // fallbacks: "default" — 安全分類器で断られたとき、サーバー側で適切なモデルに切り替えて再実行
    const params = {
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      system: SYSTEM,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: `次の ${items.length} 件の ToDo の所要時間を、同じ順番で見積もってください。\n\n${list}`,
      }],
    };
    // deno-lint-ignore no-explicit-any
    const res = await client.beta.messages.create(params as any);

    if (res.stop_reason === 'refusal') return json({ error: 'refused' }, 422);
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const parsed = JSON.parse(text) as { estimates: { minutes: number; reason: string }[] };
    const estimates = items.map((_, n) => {
      const e = parsed.estimates?.[n];
      const m = Math.round((Number(e?.minutes) || 30) / 5) * 5;
      return { minutes: Math.min(600, Math.max(5, m)), reason: String(e?.reason ?? '') };
    });
    return json({ estimates });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'rate_limited' }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: 'server misconfigured' }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: 'upstream', status: err.status }, 502);
    console.error(err);
    return json({ error: 'internal' }, 500);
  }
});
