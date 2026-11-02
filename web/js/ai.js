// ToDo の所要時間見積もり
//  - ログイン中: Supabase Edge Function "estimate"（Claude API）
//  - それ以外 / 失敗時: キーワードによる簡易見積もり

import * as sync from './sync.js';

const RULES = [
  [/メール|返信|連絡|電話|予約|申し込|振込|支払/, 15],
  [/買い物|買う|コンビニ|郵便|銀行|役所/, 45],
  [/掃除|片付|洗濯|料理|作り置き/, 60],
  [/勉強|学習|読書|復習|練習|英語|資格/, 60],
  [/資料|企画|レポート|報告書|スライド|設計|執筆|ブログ|記事/, 120],
  [/会議|打ち合わせ|ミーティング|面談/, 60],
  [/運動|ジム|ランニング|散歩|ヨガ/, 45],
];

export function heuristic(title) {
  for (const [re, m] of RULES) if (re.test(title)) return { minutes: m, reason: 'キーワードからの目安' };
  return { minutes: 30, reason: '目安（AI未接続）' };
}

/**
 * @param {{title:string, memo?:string}[]} items
 * @returns {Promise<{minutes:number, reason:string, source:'ai'|'heuristic'}[]>}
 */
export async function estimate(items) {
  const sb = sync.client();
  if (sb && sync.currentUser()) {
    try {
      const { data, error } = await sb.functions.invoke('estimate', { body: { items } });
      if (error) throw error;
      if (Array.isArray(data?.estimates) && data.estimates.length === items.length) {
        return data.estimates.map((e) => ({
          minutes: Math.max(5, Math.min(600, Math.round((+e.minutes || 30) / 5) * 5)),
          reason: String(e.reason || ''),
          source: 'ai',
        }));
      }
    } catch (e) {
      console.warn('AI estimate failed, fallback to heuristic', e);
    }
  }
  return items.map((i) => ({ ...heuristic(i.title), source: 'heuristic' }));
}

export const aiAvailable = () => !!(sync.client() && sync.currentUser());
