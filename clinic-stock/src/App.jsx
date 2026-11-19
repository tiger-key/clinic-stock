import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dbReady, dbGet, dbPut } from './db.js';
import { readWorkbook, exportWorkbook } from './excel.js';
import { buildFromRows } from './importer.js';
import { barPct, fmtStock, needsOrder, normalize, nowStr, planRuns, recommendQty, statusOf, uid } from './logic.js';

const ls = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* noop */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* noop */ } },
};

export default function App() {
  const [room, setRoom] = useState(() => ls.get('room'));
  if (!dbReady) {
    return (
      <div className="gate">
        <h1>設定が必要です</h1>
        <p>環境変数 <code>VITE_FIREBASE_URL</code> が設定されていません。手順書（DEPLOY.md）の「Vercelの設定」を確認してください。</p>
      </div>
    );
  }
  if (!room) return <Login onOk={(r) => { ls.set('room', r); setRoom(r); }} />;
  return <Main room={room} onLogout={() => { ls.del('room'); setRoom(''); }} />;
}

function Login({ onOk }) {
  const [v, setV] = useState('');
  const ok = v.trim().length >= 12;
  return (
    <div className="gate">
      <h1>院内処方 在庫・発送管理</h1>
      <p>合言葉を入力してください。同じ合言葉を入力した端末だけが、同じ在庫を見られます。</p>
      <label htmlFor="pw">合言葉（12文字以上）</label>
      <input id="pw" className="inp" type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn btn-primary" disabled={!ok} onClick={() => onOk(v.trim())}>開く</button>
      <p className="note">初めて使う合言葉で開くと、空のデータから始まります。</p>
    </div>
  );
}

function Main({ room, onLogout }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState('ship');
  const [op, setOpState] = useState(() => ls.get('op'));
  const busyRef = useRef(false);

  const setOp = (v) => { setOpState(v); ls.set('op', v); };
  const toast = (m) => { setMsg(m); setTimeout(() => setMsg(''), 4500); };

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    try { setData(normalize(await dbGet(room))); setErr(''); }
    catch (e) { setErr(e.message + '（通信または合言葉を確認してください）'); }
  }, [room]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  // 毎回「最新を読み直す → 変更する → 書く」。複数人が同時に触っても、古い画面で上書きしない
  const mutate = async (fn, okMsg) => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true);
    try {
      const cur = normalize(await dbGet(room));
      const next = fn(cur);
      await dbPut(room, next);
      setData(next);
      if (okMsg) toast(okMsg);
      return true;
    } catch (e) {
      toast(e.message || '失敗しました');
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  };
  const needOp = () => {
    if (op.trim()) return false;
    toast('先に画面上部で担当者名を入力してください');
    return true;
  };
  const ctx = { data, mutate, op, needOp, toast };

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-in">
          <h1>院内処方 在庫・発送管理</h1>
          <div className="hdr-r">
            <label htmlFor="op">担当者</label>
            <input id="op" className="inp inp-op" value={op} onChange={(e) => setOp(e.target.value)} placeholder="名前を入力" />
          </div>
        </div>
        <nav className="tabs" aria-label="画面切り替え">
          {[['ship', '発送'], ['stock', '在庫'], ['set', '設定']].map(([k, l]) => (
            <button key={k} className={'tab' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>
      </header>
      <main className="main">
        {err && <div className="err">{err} <button className="btn btn-ghost" onClick={refresh}>再読込</button></div>}
        {!data && !err && <p className="note">読み込み中…</p>}
        {data && tab === 'ship' && <ShipTab ctx={ctx} />}
        {data && tab === 'stock' && <StockTab ctx={ctx} />}
        {data && tab === 'set' && <SettingsTab ctx={ctx} onLogout={onLogout} />}
      </main>
      {busy && <div className="busy">保存中…</div>}
      {msg && <div className="toast" role="status">{msg}</div>}
    </div>
  );
}

/* ---------------- 発送 ---------------- */
function ShipTab({ ctx }) {
  const { data, mutate, op, needOp } = ctx;
  const [menu, setMenu] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [times, setTimes] = useState(1);
  const [dest, setDest] = useState('');
  const byName = useMemo(() => new Map(data.items.map((i) => [i.name, i])), [data.items]);
  const menus = [...new Set(data.plans.map((p) => p.menu || '').filter(Boolean))];
  const plan = data.plans.find((p) => p.id === sel);

  if (!data.plans.length) {
    return <p className="note">発送プランがまだ登録されていません。「設定」タブからExcelを取り込んでください。</p>;
  }

  if (plan) {
    const rows = plan.lines.map((l) => {
      const it = byName.get(l.item);
      const n = l.qty * times;
      return { l, it, n, short: !it || it.stock < n };
    });
    const anyShort = rows.some((r) => r.short);
    const label = plan.name + (times > 1 ? `×${times}` : '');
    const ship = () => {
      if (needOp()) return;
      mutate((cur) => {
        const byN = new Map(cur.items.map((i) => [i.name, i]));
        const at = nowStr();
        for (const l of plan.lines) {
          const it = byN.get(l.item);
          const n = l.qty * times;
          if (!it) throw new Error(`「${l.item}」が見つかりません`);
          if (it.stock < n) throw new Error(`「${l.item}」の在庫が足りません（現在 ${fmtStock(it)}）`);
          it.stock -= n;
          cur.ledger[it.id] = [{ eid: uid('e'), type: 'out', qty: n, at, by: op.trim(), party: `${dest.trim()} ［${label}］`.trim() }, ...(cur.ledger[it.id] || [])];
        }
        return cur;
      }, '出庫を記録しました').then((ok) => { if (ok) { setDest(''); setTimes(1); } });
    };
    return (
      <div className="stack">
        <button className="btn btn-ghost" onClick={() => { setSel(null); setTimes(1); }}>← プラン一覧へ</button>
        <div className="card">
          <div className="muted">{[plan.menu, plan.set].filter(Boolean).join(' ・ ')}</div>
          <h2 className="plan-title">{plan.name}</h2>
          <div className="stepper">
            <span className="muted">セット数</span>
            <button className="btn-sq" aria-label="セット数を減らす" onClick={() => setTimes(Math.max(1, times - 1))}>−</button>
            <strong className="num">{times}</strong>
            <button className="btn-sq" aria-label="セット数を増やす" onClick={() => setTimes(times + 1)}>＋</button>
          </div>
        </div>
        <div className="card">
          <h3>詰めるもの</h3>
          <ul className="pack">
            {rows.map(({ l, it, n, short }) => (
              <li key={l.item} className={short ? 'short' : ''}>
                <div className="pack-name">{l.item}</div>
                <div className="pack-qty">{n}<span>{l.unit}</span></div>
                <div className="pack-sub">
                  {it ? <>在庫 {fmtStock(it)}</> : '薬剤マスタにありません'}
                  {short && <strong className="red">　在庫不足</strong>}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="card stack">
          <label htmlFor="dest">発送先・配送番号など（自由入力）</label>
          <input id="dest" className="inp" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="例：ヤマト 1234-5678-9012" />
          {anyShort && <div className="red small">在庫が足りない薬剤があるため出庫できません。在庫を確認してください。</div>}
          <button className="btn btn-primary btn-lg" disabled={anyShort} onClick={ship}>出庫を記録する</button>
        </div>
      </div>
    );
  }

  const ql = q.trim().toLowerCase();
  const shown = data.plans.filter((p) => (menu === '' || (p.menu || '') === menu) && (!ql || p.name.toLowerCase().includes(ql)));
  return (
    <div className="stack">
      <input className="inp" type="search" aria-label="プラン名で検索" placeholder="プラン名で検索" value={q} onChange={(e) => setQ(e.target.value)} />
      {menus.length > 0 && (
        <div className="chips">
          <button className={'chip' + (menu === '' ? ' on' : '')} onClick={() => setMenu('')}>すべて</button>
          {menus.map((m) => (
            <button key={m} className={'chip' + (menu === m ? ' on' : '')} onClick={() => setMenu(m)}>{m}</button>
          ))}
        </div>
      )}
      {shown.length === 0 && <p className="note">該当するプランがありません</p>}
      {shown.map((p) => {
        const runs = planRuns(p, byName);
        return (
          <button key={p.id} className="card plan-card" onClick={() => setSel(p.id)}>
            <div>
              <div className="muted">{[p.menu, p.set].filter(Boolean).join(' ・ ')}</div>
              <div className="plan-name">{p.name}</div>
              <div className="muted">{p.lines.length}品目</div>
            </div>
            <span className={'badge ' + (runs <= 0 ? 'b-bad' : runs <= 2 ? 'b-warn' : 'b-ok')}>
              {runs <= 0 ? '在庫不足' : `あと${runs}回分`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- 在庫 ---------------- */
function StockTab({ ctx }) {
  const { data } = ctx;
  const [f, setF] = useState('need');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const need = data.items.filter(needsOrder).sort((a, b) => a.stock / (a.target || a.min) - b.stock / (b.target || b.min));
  const ordered = data.items.filter((i) => i.ordered);
  const out = data.items.filter((i) => i.min > 0 && i.stock <= 0);
  const ql = q.trim().toLowerCase();
  let rows = f === 'need' ? need : f === 'ordered' ? ordered : data.items;
  if (ql) rows = rows.filter((i) => (i.name + i.cat).toLowerCase().includes(ql));

  if (!data.items.length) return <p className="note">薬剤がまだ登録されていません。「設定」タブからExcelを取り込んでください。</p>;
  return (
    <div className="stack">
      <div className="sum">
        <div className="card"><span className="muted">発注が必要</span><strong className="big red">{need.length}</strong></div>
        <div className="card"><span className="muted">在庫切れ</span><strong className="big">{out.length}</strong></div>
        <div className="card"><span className="muted">発注済（入荷待ち）</span><strong className="big teal">{ordered.length}</strong></div>
      </div>
      <div className="chips">
        {[['need', `発注が必要 (${need.length})`], ['ordered', `発注済 (${ordered.length})`], ['all', `全在庫 (${data.items.length})`]].map(([k, l]) => (
          <button key={k} className={'chip' + (f === k ? ' on' : '')} onClick={() => setF(k)}>{l}</button>
        ))}
      </div>
      <input className="inp" type="search" aria-label="薬剤名で検索" placeholder="薬剤名・カテゴリで検索" value={q} onChange={(e) => setQ(e.target.value)} />
      {rows.length === 0 && <p className="note">この一覧に該当する薬剤はありません</p>}
      {rows.map((it) => (
        <StockRow key={it.id} it={it} ctx={ctx} open={open === it.id} onToggle={() => setOpen(open === it.id ? null : it.id)} />
      ))}
    </div>
  );
}

function StockRow({ it, ctx, open, onToggle }) {
  const { data, mutate, op, needOp, toast } = ctx;
  const st = statusOf(it);
  const per = it.perBox > 1 ? it.perBox : 1;
  const [ordQty, setOrdQty] = useState(null);
  const oq = ordQty ?? recommendQty(it);
  const [mode, setMode] = useState('in');
  const [fb, setFb] = useState('');
  const [fl, setFl] = useState('');
  const [party, setParty] = useState('');
  const ledger = data.ledger[it.id] || [];
  const n = (parseInt(fb, 10) || 0) * per + (parseInt(fl, 10) || 0);
  const over = mode === 'out' && n > it.stock;
  const edit = (fn, okMsg) => mutate((cur) => {
    const x = cur.items.find((i) => i.id === it.id);
    if (!x) throw new Error('この薬剤は見つかりません');
    fn(x, cur);
    return cur;
  }, okMsg);
  const pushLedger = (cur, e) => { cur.ledger[it.id] = [{ eid: uid('e'), at: nowStr(), by: op.trim(), ...e }, ...(cur.ledger[it.id] || [])]; };

  const record = () => {
    if (needOp()) return;
    if (n <= 0) { toast('数量を入力してください'); return; }
    if (over) { toast('在庫を超える数は出庫できません'); return; }
    edit((x, cur) => {
      if (mode === 'out' && x.stock < n) throw new Error('在庫を超える数は出庫できません');
      x.stock += mode === 'in' ? n : -n;
      pushLedger(cur, { type: mode, qty: n, party: party.trim() });
    }, mode === 'in' ? '入庫を記録しました' : '出庫を記録しました').then((ok) => { if (ok) { setFb(''); setFl(''); setParty(''); } });
  };
  const undo = (e) => {
    if (needOp()) return;
    if (!window.confirm('この記録を取り消しますか？在庫も元に戻ります。')) return;
    edit((x, cur) => {
      const d = e.type === 'in' ? -e.qty : e.qty;
      if (x.stock + d < 0) throw new Error('取り消すと在庫がマイナスになるため取り消せません');
      x.stock += d;
      cur.ledger[it.id] = (cur.ledger[it.id] || []).filter((y) => y.eid !== e.eid);
    }, '取り消しました');
  };
  const order = () => { if (needOp()) return; edit((x) => { x.ordered = { qty: oq, at: nowStr(), by: op.trim() }; }, '発注済にしました'); };
  const cancelOrder = () => { if (needOp()) return; edit((x) => { x.ordered = null; }, '発注を取り消しました'); };
  const receive = () => {
    if (needOp()) return;
    edit((x, cur) => {
      if (!x.ordered) throw new Error('すでに入荷済みです');
      const qty = x.ordered.qty;
      x.stock += qty;
      x.ordered = null;
      pushLedger(cur, { type: 'in', qty, party: '卸（発注分の入荷）' });
    }, '入荷を記録しました');
  };

  return (
    <div className="card row">
      <div className="row-main">
        <div className="row-name">
          <strong>{it.name}</strong>
          <span className={'badge ' + (it.ordered ? 'b-info' : st.cls)}>{it.ordered ? '発注済' : st.label}</span>
        </div>
        <div className="muted">{[it.cat, it.supplier].filter(Boolean).join(' ・ ')}</div>
        <div className="bar"><div style={{ width: barPct(it) + '%', background: st.bar }} /></div>
      </div>
      <div className="row-nums">
        <div><span className="muted">現在庫</span><strong className="stock">{fmtStock(it)}</strong></div>
        <div><span className="muted">最低在庫</span><span className="sub">{it.min > 0 ? fmtStock(it, it.min) : '—'}</span></div>
      </div>
      {needsOrder(it) && (
        <div className="row-act">
          <div className="stepper">
            <button className="btn-sq" aria-label="発注数を減らす" onClick={() => setOrdQty(Math.max(per, oq - per))}>−</button>
            <div className="ord"><span className="muted">発注数</span><strong>{fmtStock(it, oq)}</strong></div>
            <button className="btn-sq" aria-label="発注数を増やす" onClick={() => setOrdQty(oq + per)}>＋</button>
          </div>
          <button className="btn btn-primary" onClick={order}>発注済にする</button>
        </div>
      )}
      {it.ordered && (
        <div className="row-act">
          <div className="ord-info"><strong className="teal">{fmtStock(it, it.ordered.qty)} 発注済</strong><span className="muted">{it.ordered.at} ・ {it.ordered.by}</span></div>
          <button className="btn btn-ghost" onClick={cancelOrder}>取消</button>
          <button className="btn btn-outline" onClick={receive}>入荷にする</button>
        </div>
      )}
      <div className="row-more"><button className="btn btn-ghost" onClick={onToggle}>{open ? '閉じる' : '詳細・出納'}</button></div>
      {open && (
        <div className="detail">
          <div className="chips">
            <span className="strong">出納を記録</span>
            <button className={'chip' + (mode === 'in' ? ' on' : '')} onClick={() => setMode('in')}>卸から入庫</button>
            <button className={'chip' + (mode === 'out' ? ' on' : '')} onClick={() => setMode('out')}>出庫</button>
          </div>
          <div className="form">
            {per > 1 && (
              <div className="fld"><label>箱</label><input className="inp inp-num" inputMode="numeric" value={fb} onChange={(e) => setFb(e.target.value)} placeholder="0" /></div>
            )}
            <div className="fld"><label>{per > 1 ? `バラ（${it.unit}）` : `数量（${it.unit}）`}</label><input className="inp inp-num" inputMode="numeric" value={fl} onChange={(e) => setFl(e.target.value)} placeholder="0" /></div>
            <div className="fld grow"><label>{mode === 'in' ? '入庫元（卸の名前など）' : '発送先・配送番号など'}</label><input className="inp" value={party} onChange={(e) => setParty(e.target.value)} /></div>
            <button className="btn btn-primary" onClick={record}>{mode === 'in' ? '入庫を記録' : '出庫を記録'}</button>
          </div>
          {n > 0 && <div className="small muted">記録する数量：{fmtStock(it, n)}</div>}
          {over && <div className="red small">現在庫を超える数は出庫できません</div>}
          <div className="strong">出納履歴</div>
          {ledger.length === 0 && <div className="muted small">まだ履歴がありません</div>}
          {ledger.map((e) => (
            <div key={e.eid} className="led">
              <span className={'badge ' + (e.type === 'in' ? 'b-ok' : 'b-warn')}>{e.type === 'in' ? '入庫' : '出庫'}</span>
              <strong className="led-q">{e.type === 'in' ? '+' : '−'}{fmtStock(it, e.qty)}</strong>
              <span className="led-p">{e.party || '（記載なし）'}</span>
              <span className="muted small">{e.at} ・ {e.by}</span>
              <button className="btn btn-ghost" onClick={() => undo(e)}>取り消す</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- 設定 ---------------- */
function SettingsTab({ ctx, onLogout }) {
  const { data, mutate, toast } = ctx;
  const [mode, setMode] = useState('plans');
  const [wb, setWb] = useState(null);
  const [fname, setFname] = useState('');
  const fileRef = useRef(null);
  const result = useMemo(() => (wb ? buildFromRows(wb.itemRows, wb.planRows, data.items, mode) : null), [wb, mode, data.items]);

  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try { setWb(await readWorkbook(f)); setFname(f.name); }
    catch { toast('Excelを読み込めませんでした（.xlsxか確認してください）'); }
  };
  const apply = () => {
    if (!result || result.errors.length) return;
    const msg = mode === 'full'
      ? `薬剤${result.items.length}件・プラン${result.plans.length}件で、現在のデータを【すべて置き換え】ます。現在の在庫と出納履歴は消えます。よろしいですか？`
      : `発送プラン${result.plans.length}件に置き換えます（在庫・履歴はそのまま）。よろしいですか？`;
    if (!window.confirm(msg)) return;
    mutate((cur) => {
      const r = buildFromRows(wb.itemRows, wb.planRows, cur.items, mode);
      if (r.errors.length) throw new Error('取り込みエラー：' + r.errors[0]);
      return mode === 'full' ? { items: r.items, plans: r.plans, ledger: {} } : { ...cur, plans: r.plans };
    }, '取り込みました').then((ok) => { if (ok) { setWb(null); setFname(''); if (fileRef.current) fileRef.current.value = ''; } });
  };

  return (
    <div className="stack">
      <div className="card stack">
        <h3>Excelを取り込む</h3>
        <p className="small muted">入稿用Excelのひな形は <a href="/template.xlsx" download>こちら（template.xlsx）</a>。</p>
        <div className="chips">
          <button className={'chip' + (mode === 'plans' ? ' on' : '')} onClick={() => setMode('plans')}>発送プランだけ更新</button>
          <button className={'chip' + (mode === 'full' ? ' on' : '')} onClick={() => setMode('full')}>薬剤＋在庫＋プランを全置換（初回）</button>
        </div>
        <p className="small muted">{mode === 'full' ? '初回セットアップ用です。現在の在庫・履歴は消えて、Excelの内容で始まります。' : '在庫と履歴はそのままで、発送プランだけ入れ替えます。品名は薬剤マスタと一致している必要があります。'}</p>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onFile} aria-label="Excelファイルを選ぶ" />
        {result && (
          <div className="stack">
            <div className="small">{fname}：薬剤 {result.items.length}件 ／ プラン {result.plans.length}件（{result.plans.reduce((s, p) => s + p.lines.length, 0)}行）</div>
            {result.errors.length > 0 && (
              <div className="box-err"><strong>修正が必要です（{result.errors.length}件）</strong><ul>{result.errors.slice(0, 30).map((e, i) => <li key={i}>{e}</li>)}</ul>{result.errors.length > 30 && <div>ほか{result.errors.length - 30}件</div>}</div>
            )}
            {result.warnings.length > 0 && (
              <div className="box-warn"><strong>確認（{result.warnings.length}件・取り込みは可能）</strong><ul>{result.warnings.slice(0, 15).map((e, i) => <li key={i}>{e}</li>)}</ul></div>
            )}
            <button className="btn btn-primary" disabled={result.errors.length > 0} onClick={apply}>この内容で取り込む</button>
          </div>
        )}
      </div>
      <div className="card stack">
        <h3>バックアップ</h3>
        <p className="small muted">薬剤・在庫・プラン・出納履歴をExcelに書き出します。書き出した「薬剤マスタ」「発送プラン」は、そのまま再取り込みできます。</p>
        <button className="btn btn-outline" onClick={() => exportWorkbook(data)}>Excelに書き出す</button>
      </div>
      <div className="card stack">
        <h3>この端末</h3>
        <p className="small muted">合言葉をこの端末から忘れさせます（データは消えません）。</p>
        <button className="btn btn-ghost" onClick={onLogout}>合言葉を入力し直す</button>
      </div>
    </div>
  );
}
