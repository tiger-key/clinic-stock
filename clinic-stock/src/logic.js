export const uid = (p = 'x') => p + Math.random().toString(36).slice(2, 9);

export const nowStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Firebaseは空配列やnullを落とすので、読み込み時に形を揃える
export function normalize(d) {
  d = d || {};
  return {
    items: (d.items || []).map((i) => ({ ...i, ordered: i.ordered || null })),
    plans: (d.plans || []).map((p) => ({ ...p, lines: (p.lines || []).map((l) => ({ ...l })) })),
    ledger: d.ledger || {},
  };
}

export function split(n, per) {
  if (!(per > 1)) return { box: 0, loose: n };
  return { box: Math.floor(n / per), loose: n % per };
}

// 例: 3箱＋40錠
export function fmtStock(it, n = it.stock) {
  if (!(it.perBox > 1)) return `${n}${it.unit}`;
  const { box, loose } = split(n, it.perBox);
  if (box && loose) return `${box}箱＋${loose}${it.unit}`;
  if (box) return `${box}箱`;
  return `${loose}${it.unit}`;
}

export function statusOf(it) {
  if (!(it.min > 0)) return { k: 'na', label: '基準なし', cls: 'b-na', bar: '#8A9A94' };
  if (it.stock <= 0) return { k: 'out', label: '在庫切れ', cls: 'b-bad', bar: '#B42318' };
  if (it.stock <= it.min * 0.5) return { k: 'critical', label: '要至急', cls: 'b-bad', bar: '#B42318' };
  if (it.stock <= it.min) return { k: 'low', label: '最低在庫以下', cls: 'b-warn', bar: '#C77A0A' };
  return { k: 'ok', label: '十分', cls: 'b-ok', bar: '#2E8B78' };
}

export const needsOrder = (it) => it.min > 0 && it.stock <= it.min && !it.ordered;

// 推奨発注数（数える単位）。補充目標までの不足を、箱単位に切り上げる
export function recommendQty(it) {
  const per = it.perBox > 1 ? it.perBox : 1;
  const lack = Math.max((it.target || 0) - it.stock, 0);
  return Math.max(Math.ceil(lack / per), 1) * per;
}

export function barPct(it) {
  const base = it.target > 0 ? it.target : it.min > 0 ? it.min * 2 : 0;
  if (!base) return 0;
  return Math.max(0, Math.min(100, Math.round((it.stock / base) * 100)));
}

// このプランをあと何回分出せるか
export function planRuns(plan, itemByName) {
  if (!plan.lines.length) return 0;
  let m = Infinity;
  for (const l of plan.lines) {
    const it = itemByName.get(l.item);
    if (!it || !(l.qty > 0)) return 0;
    m = Math.min(m, Math.floor(it.stock / l.qty));
  }
  return m === Infinity ? 0 : m;
}
