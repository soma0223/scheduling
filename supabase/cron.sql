-- 通知送信を毎分実行する（Supabase の SQL Editor で、値を置き換えてから1回実行）
--   <PROJECT_REF>   : プロジェクトの ref（https://<PROJECT_REF>.supabase.co）
--   <CRON_SECRET>   : `supabase secrets set CRON_SECRET=...` で設定したのと同じ値
-- Dashboard → Database → Extensions で pg_cron と pg_net を有効にしておくこと。

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('push-dispatch') where exists (select 1 from cron.job where jobname = 'push-dispatch');

select cron.schedule(
  'push-dispatch',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/push-dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
