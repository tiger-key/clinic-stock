// Firebase Realtime Database (REST)。合言葉(room)をパスの一部にして、同じ合言葉の端末だけが同じデータを共有する。
const BASE = (import.meta.env.VITE_FIREBASE_URL || '').replace(/\/+$/, '');
export const dbReady = !!BASE;
const url = (room) => `${BASE}/${encodeURIComponent(room)}/stock.json`;

export async function dbGet(room) {
  const r = await fetch(url(room), { cache: 'no-store' });
  if (!r.ok) throw new Error('読み込みエラー ' + r.status);
  return await r.json();
}
export async function dbPut(room, data) {
  const r = await fetch(url(room), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error('保存エラー ' + r.status);
}
