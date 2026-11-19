// Excelの行データ → アプリのデータ。xlsxライブラリに依存しない純粋関数（テストしやすいように分離）
import { uid } from './logic.js';

const norm = (s) =>
  String(s ?? '')
    .replace(/[\s　]/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')');

function findCol(h, ...keys) {
  for (const k of keys) {
    const nk = norm(k);
    let i = h.indexOf(nk);
    if (i < 0) i = h.findIndex((x) => x.startsWith(nk));
    if (i >= 0) return i;
  }
  return -1;
}

const num = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
// 空行判定。計算列（現在庫）や「=」で始まる数式セルは無視する
const blank = (row, ignore = []) =>
  row.every((c, i) => ignore.includes(i) || String(c ?? '').trim() === '' || String(c).startsWith('='));
const str = (v) => String(v ?? '').trim();

// mode: 'full'  = 薬剤マスタ＋在庫＋プランを全置換 / 'plans' = プランだけ（薬剤は現在のものを使う）
export function buildFromRows(itemRows, planRows, currentItems, mode) {
  const errors = [];
  const warnings = [];
  let items = currentItems;

  if (mode === 'full') {
    items = [];
    if (!itemRows || !itemRows.length) {
      errors.push('「薬剤マスタ」シートが見つかりません（シート名に「薬剤」を含めてください）');
    } else {
      const h = itemRows[0].map(norm);
      const c = {
        name: findCol(h, '品名'),
        cat: findCol(h, 'カテゴリ'),
        unit: findCol(h, '数える単位', '単位'),
        perBox: findCol(h, '1箱の入数', '大単位'),
        boxes: findCol(h, '未開封'),
        loose: findCol(h, 'バラ'),
        min: findCol(h, '最低在庫'),
        target: findCol(h, '補充目標'),
        supplier: findCol(h, '主な卸'),
        note: findCol(h, '備考'),
        stockCalc: findCol(h, '現在庫'),
      };
      const need = { name: '品名', unit: '数える単位', perBox: '1箱の入数', boxes: '未開封（箱）', loose: 'バラ', min: '最低在庫', target: '補充目標' };
      for (const k of Object.keys(need)) if (c[k] < 0) errors.push(`薬剤マスタに列「${need[k]}」がありません`);
      if (!errors.length) {
        const seen = new Set();
        for (let r = 1; r < itemRows.length; r++) {
          const row = itemRows[r];
          if (blank(row, [c.stockCalc])) continue;
          const ln = `薬剤マスタ ${r + 1}行目`;
          const name = str(row[c.name]);
          if (!name) { errors.push(`${ln}：品名が空です`); continue; }
          if (seen.has(norm(name))) { errors.push(`${ln}：品名「${name}」が重複しています`); continue; }
          seen.add(norm(name));
          const unit = str(row[c.unit]);
          if (!unit) errors.push(`${ln}「${name}」：数える単位が空です`);
          const vals = {};
          let bad = false;
          for (const [k, label, dflt] of [['perBox', '1箱の入数', 1], ['boxes', '未開封（箱）', 0], ['loose', 'バラ', 0], ['min', '最低在庫', 0], ['target', '補充目標', 0]]) {
            const v = num(row[c[k]]);
            if (v === null) vals[k] = dflt;
            else if (Number.isNaN(v) || v < 0 || !Number.isInteger(v) || (k === 'perBox' && v < 1)) {
              errors.push(`${ln}「${name}」：${label}が正しい整数ではありません（${row[c[k]]}）`);
              bad = true;
            } else vals[k] = v;
          }
          if (bad || !unit) continue;
          if (vals.min > 0 && vals.target > 0 && vals.target < vals.min) warnings.push(`${ln}「${name}」：補充目標が最低在庫より少ないです`);
          if (!(vals.min > 0)) warnings.push(`${ln}「${name}」：最低在庫が未設定のため、発注アラートの対象外です`);
          items.push({
            id: uid('i'),
            name,
            cat: c.cat >= 0 ? str(row[c.cat]) : '',
            unit,
            perBox: vals.perBox,
            stock: vals.perBox * vals.boxes + vals.loose,
            min: vals.min,
            target: vals.target,
            supplier: c.supplier >= 0 ? str(row[c.supplier]) : '',
            note: c.note >= 0 ? str(row[c.note]) : '',
            ordered: null,
          });
        }
        if (!items.length) errors.push('薬剤が1件も読み込めませんでした');
      }
    }
  }

  // ---- 発送プラン ----
  const plans = [];
  if (!planRows || !planRows.length) {
    if (mode === 'plans') errors.push('「発送プラン」シートが見つかりません（シート名に「発送」を含めてください）');
    else warnings.push('「発送プラン」シートがないため、プランは0件になります');
  } else if (items.length || mode === 'plans') {
    const byName = new Map(items.map((i) => [norm(i.name), i]));
    const h = planRows[0].map(norm);
    const c = {
      plan: findCol(h, 'プラン名'),
      menu: findCol(h, '大メニュー'),
      set: findCol(h, 'セット名'),
      months: findCol(h, '月数'),
      item: findCol(h, '品名'),
      qty: findCol(h, '数量'),
      unit: findCol(h, '数量の単位', 'ユニット'),
    };
    for (const [k, label] of [['plan', 'プラン名'], ['item', '品名'], ['qty', '数量']]) {
      if (c[k] < 0) errors.push(`発送プランに列「${label}」がありません`);
    }
    if (!errors.some((e) => e.startsWith('発送プランに列'))) {
      const map = new Map();
      let last = '';
      for (let r = 1; r < planRows.length; r++) {
        const row = planRows[r];
        if (blank(row)) continue;
        const ln = `発送プラン ${r + 1}行目`;
        let pname = str(row[c.plan]);
        if (!pname) pname = last; // 結合セット対策：空欄は上の行のプラン名を引き継ぐ
        if (!pname) { errors.push(`${ln}：プラン名が空です`); continue; }
        last = pname;
        if (!map.has(pname)) {
          map.set(pname, {
            id: uid('p'),
            name: pname,
            menu: c.menu >= 0 ? str(row[c.menu]) : '',
            set: c.set >= 0 ? str(row[c.set]) : '',
            months: c.months >= 0 ? str(row[c.months]) : '',
            lines: [],
          });
        }
        const plan = map.get(pname);
        const iname = str(row[c.item]);
        const it = byName.get(norm(iname));
        if (!it) { errors.push(`${ln}（${pname}）：品名「${iname}」が薬剤マスタにありません`); continue; }
        const q = num(row[c.qty]);
        if (!(q > 0) || !Number.isInteger(q)) { errors.push(`${ln}（${pname} / ${iname}）：数量は1以上の整数にしてください`); continue; }
        const u = c.unit >= 0 ? str(row[c.unit]) : '';
        if (u && u !== it.unit) { errors.push(`${ln}（${pname} / ${iname}）：数量の単位「${u}」が薬剤の単位「${it.unit}」と違います`); continue; }
        if (plan.lines.some((l) => l.item === it.name)) { errors.push(`${ln}（${pname}）：「${iname}」が同じプランに2回あります`); continue; }
        plan.lines.push({ item: it.name, qty: q, unit: it.unit });
      }
      for (const p of map.values()) plans.push(p);
    }
  }

  return { items, plans, errors, warnings };
}
