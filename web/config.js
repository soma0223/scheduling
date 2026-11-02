// デプロイ時に自分の値を入れてください（README 参照）。
// 空のままでも、この端末だけで動くローカルモードとして使えます。
// anon key と VAPID 公開鍵は公開してよい値です（秘密鍵は Supabase の secrets に置く）。
export default {
  supabaseUrl: '', // 例: https://xxxx.supabase.co
  supabaseAnonKey: '',
  vapidPublicKey: '', // npx web-push generate-vapid-keys の publicKey
};
