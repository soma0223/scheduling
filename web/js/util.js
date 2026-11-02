// 日付・時刻まわりの小さなヘルパー（UI・スケジューラ・テストで共有）

export const WD = ['日', '月', '火', '水', '木', '金', '土'];

/** "HH:MM" → 0時からの分 */
export const toM = (t) => {
  if (!t) return NaN;
  const [a, b] = t.split(':').map(Number);
  return a * 60 + b;
};

/** 分 → "HH:MM"（24:00 も許可） */
export const fm = (m) =>
  String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

/** 分 → "1時間30分" */
export const dur = (m) =>
  m < 60 ? m + '分' : Math.floor(m / 60) + '時間' + (m % 60 ? (m % 60) + '分' : '');

/** Date → "YYYY-MM-DD"（ローカル） */
export const ymd = (d) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

/** "YYYY-MM-DD" → Date（ローカル 0:00） */
export const pd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const addDays = (k, n) => {
  const d = pd(k);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

export const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();

/** ローカル日付 + "HH:MM" → ISO 文字列（サーバー側の通知判定に使う） */
export const toISO = (date, time) => {
  const d = pd(date);
  const m = toM(time);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return d.toISOString();
};

export const label = (k) => {
  const d = pd(k);
  return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`;
};

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const roundUp = (m, step = 5) => Math.ceil(m / step) * step;
