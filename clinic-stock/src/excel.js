import * as XLSX from 'xlsx';
import { split } from './logic.js';

export async function readWorkbook(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const pick = (kw) => wb.SheetNames.find((n) => n.includes(kw));
  const rows = (n) => (n ? XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: true }) : null);
  return { itemRows: rows(pick('薬剤')), planRows: rows(pick('発送')) };
}

// バックアップ兼用：書き出したファイルはそのまま再取り込みできる形式
export function exportWorkbook(data) {
  const wb = XLSX.utils.book_new();
  const items = data.items.map((i) => {
    const s = split(i.stock, i.perBox);
    return {
      品名: i.name, カテゴリ: i.cat, 数える単位: i.unit, '1箱の入数': i.perBox,
      '未開封（箱）': s.box, バラ: s.loose, 現在庫: i.stock,
      最低在庫: i.min, 補充目標: i.target, 主な卸: i.supplier || '', 備考: i.note || '',
    };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(items), '薬剤マスタ');
  const plans = [];
  for (const p of data.plans) {
    for (const l of p.lines) {
      plans.push({ プラン名: p.name, 大メニュー: p.menu, セット名: p.set, 月数: p.months, 品名: l.item, 数量: l.qty, 数量の単位: l.unit });
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(plans), '発送プラン');
  const led = [];
  for (const i of data.items) {
    for (const e of data.ledger[i.id] || []) {
      led.push({ 日時: e.at, 品名: i.name, 区分: e.type === 'in' ? '入庫' : '出庫', 数量: e.qty, 単位: i.unit, '入庫元／発送先': e.party || '', 担当者: e.by });
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(led), '出納履歴');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  XLSX.writeFile(wb, `在庫バックアップ_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.xlsx`);
}
