/* ===== Métricas — Tráfego Pago · app ===== */
'use strict';

/* ---------- Supabase ---------- */
const SUPABASE_URL = 'https://nyuycffqncuavzuhyofq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_soW7Jl52hpZYkaJtmDT6tg_4111FV8W';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- Estado ---------- */
let rows = [];      // ads_metricas_diarias do projeto ativo (asc por data)
let adRows = [];    // ads_anuncios_diarios do projeto ativo (asc por data)
let projetos = [];  // linhas completas de ads_projetos
let projeto = localStorage.getItem('ads_dash_projeto') || 'principal';
let eco = { taxa_pct: 0, imposto_pct: 0, custo_por_venda: 0, margem_alvo_pct: 20 };
let period = 0;     // 0 = tudo, 1 = hoje, 7, 30, -1 = intervalo personalizado
let range = { de: '', ate: '' };
try { range = { ...range, ...JSON.parse(localStorage.getItem('ads_dash_range') || '{}') }; } catch (e) { /* usa default */ }
let editingId = null;
let editingAdId = null;
let expandedDia = null;          // data ISO do dia expandido na tabela
let selectedAds = null;          // Set de anúncios no gráfico de comparação
let sortGeral = { key: 'data', dir: -1 };
let sortRank = { key: 'lucro', dir: -1 };
let sortHist = { key: 'data', dir: -1 };
const charts = {};

const DEFAULT_SETTINGS = { perdaMax: 20, spikePct: 30 };
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('ads_dash_settings') || '{}') }; } catch (e) { /* usa default */ }

/* ---------- Paleta (validada — dataviz) ---------- */
const SERIES = ['#3987e5', '#199e70', '#c98500', '#9085e9', '#e66767', '#d55181', '#d95926', '#008300'];
const RAMP = ['#9ec5f4', '#5598e7', '#256abf'];   // rampa ordinal do funil (validada --ordinal)
const C = {
  text: '#f2f2f5', text2: '#a0a0ab', muted: '#8b8b96', grid: '#26262c', zero: '#383835',
  card: '#14141b', card2: '#1c1c24', good: '#34c759', bad: '#e66767', ref: '#55555f',
};

/* ---------- Helpers de número/data (pt-BR) ---------- */
const nfBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

function parseNum(str) {
  if (str === null || str === undefined) return null;
  let s = String(str).trim().replace(/R\$|%|\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function parseInt0(str) { const n = parseNum(str); return n === null ? null : Math.round(n); }
const fmtBRL = v => v == null ? '—' : nfBRL.format(v);
const fmtNum = v => v == null ? '—' : nf0.format(v);
const fmtDec = v => v == null ? '—' : nf2.format(v);
const fmtPct = v => v == null ? '—' : nf2.format(v) + '%';
function numToInput(v) { return v == null ? '' : String(v).replace('.', ','); }
const num = v => v == null ? 0 : Number(v);

function isoOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function todayISO() { return isoOf(new Date()); }
function fmtData(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y.slice(2)}`; }
function fmtDataCurta(iso) { const [, m, d] = iso.split('-'); return `${d}/${m}`; }

/* =================================================================
   MÉTRICAS DERIVADAS
   `faturado` é BRUTO aprovado. Líquido, lucro e margem são derivados
   da economia do projeto — nunca digitados (exceto override).
================================================================= */
function dedPct() { return num(eco.taxa_pct) + num(eco.imposto_pct); }
function temEconomia() { return dedPct() > 0 || num(eco.custo_por_venda) > 0; }

function liquidoOf(r) {
  if (r.faturamento_liquido != null) return Number(r.faturamento_liquido);
  if (r.faturado == null) return null;
  return Number(r.faturado) * (1 - dedPct() / 100) - num(r.vendas_reembolsadas) - num(r.vendas_chargeback);
}
function lucroOf(r) {
  const liq = liquidoOf(r);
  if (liq == null || r.gasto == null) return null;
  return liq - Number(r.gasto) - num(eco.custo_por_venda) * num(r.compra) - num(r.despesas_adicionais);
}
function margemOf(r) {
  const liq = liquidoOf(r), l = lucroOf(r);
  return (liq != null && liq > 0 && l != null) ? (l / liq) * 100 : null;
}
function breakevenRoas() { const d = dedPct(); return d >= 100 ? null : 1 / (1 - d / 100); }
function roasAlvo() { const b = breakevenRoas(); return b == null ? null : b * (1 + num(eco.margem_alvo_pct) / 100); }

function roasOf(r) { return r.roi != null ? Number(r.roi) : (r.gasto > 0 && r.faturado != null ? r.faturado / r.gasto : null); }
function taxaOf(r) { return r.taxa_conversao_checkout != null ? Number(r.taxa_conversao_checkout) : (r.finalizacao_compra > 0 && r.compra != null ? (r.compra / r.finalizacao_compra) * 100 : null); }
function perdaOf(r) { return r.perda_trafego != null ? Number(r.perda_trafego) : (r.cliques > 0 && r.visualizacao_destino != null ? ((r.cliques - r.visualizacao_destino) / r.cliques) * 100 : null); }
function cpaDiaOf(r) { return r.compra > 0 && r.gasto != null ? r.gasto / r.compra : null; }
function custoIcOf(r) { return r.finalizacao_compra > 0 && r.gasto != null ? r.gasto / r.finalizacao_compra : null; }
function custoLpOf(r) { return r.visualizacao_destino > 0 && r.gasto != null ? r.gasto / r.visualizacao_destino : null; }

/* nível anúncio */
function cpaAdOf(r) { return r.custo_por_compra != null ? Number(r.custo_por_compra) : (r.compras > 0 && r.gasto != null ? r.gasto / r.compras : null); }
function adRoasOf(r) { return r.roi != null ? Number(r.roi) : (r.gasto > 0 && r.faturado != null ? r.faturado / r.gasto : null); }
function adLiquidoOf(r) { return r.faturado == null ? null : Number(r.faturado) * (1 - dedPct() / 100); }
function adLucroOf(r) {
  const liq = adLiquidoOf(r);
  if (liq == null || r.gasto == null) return null;
  return liq - Number(r.gasto) - num(eco.custo_por_venda) * num(r.compras);
}

/* CPA alvo: quanto pode custar uma venda mantendo a margem alvo.
   Calibrado pelo ticket líquido de TODO o histórico do projeto. */
function ticketLiquidoProjeto() {
  let liq = 0, comp = 0;
  for (const r of rows) { const l = liquidoOf(r); if (l != null) liq += l; comp += num(r.compra); }
  if (comp === 0) {
    for (const r of adRows) { const l = adLiquidoOf(r); if (l != null) liq += l; comp += num(r.compras); }
  }
  return comp > 0 ? liq / comp : null;
}
function cpaAlvo() {
  const t = ticketLiquidoProjeto();
  if (t == null || t <= 0) return null;
  return (t - num(eco.custo_por_venda)) / (1 + num(eco.margem_alvo_pct) / 100);
}

/* agregados de um conjunto de dias */
function totais(list) {
  const t = { gasto: 0, faturado: 0, liquido: 0, lucro: 0, compra: 0, cliques: 0, lp: 0, ic: 0, iniciadas: 0, dias: list.length, temLiquido: false, temIniciadas: false };
  for (const r of list) {
    t.gasto += num(r.gasto); t.faturado += num(r.faturado); t.compra += num(r.compra);
    t.cliques += num(r.cliques); t.lp += num(r.visualizacao_destino); t.ic += num(r.finalizacao_compra);
    if (r.vendas_iniciadas != null) { t.iniciadas += Number(r.vendas_iniciadas); t.temIniciadas = true; }
    const l = liquidoOf(r); if (l != null) { t.liquido += l; t.temLiquido = true; }
    const p = lucroOf(r); if (p != null) t.lucro += p;
  }
  t.roas = t.gasto > 0 ? t.faturado / t.gasto : null;
  t.margem = t.liquido > 0 ? (t.lucro / t.liquido) * 100 : null;
  t.cpa = t.compra > 0 ? t.gasto / t.compra : null;
  t.ticket = t.compra > 0 ? t.liquido / t.compra : null;
  t.custoIc = t.ic > 0 ? t.gasto / t.ic : null;
  t.custoLp = t.lp > 0 ? t.gasto / t.lp : null;
  t.cpc = t.cliques > 0 ? t.gasto / t.cliques : null;
  t.aprov = t.temIniciadas && t.iniciadas > 0 ? (t.compra / t.iniciadas) * 100 : null;
  t.lpPorClique = t.cliques > 0 ? (t.lp / t.cliques) * 100 : null;
  t.icPorLp = t.lp > 0 ? (t.ic / t.lp) * 100 : null;
  t.compraPorIc = t.ic > 0 ? (t.compra / t.ic) * 100 : null;
  return t;
}

/* média dos até 7 registros anteriores (alerta de pico de CPC/CPM) */
function avgPrev(list, idx, field) {
  const prev = [];
  for (let i = idx - 1; i >= 0 && prev.length < 7; i--) {
    const v = list[i][field];
    if (v != null) prev.push(Number(v));
  }
  if (prev.length < 2) return null;
  return prev.reduce((a, b) => a + b, 0) / prev.length;
}
function spikeClass(list, idx, field) {
  const v = list[idx][field];
  if (v == null) return '';
  const a = avgPrev(list, idx, field);
  if (a == null) return '';
  return Number(v) > a * (1 + settings.spikePct / 100) ? 'warn' : '';
}

/* ---------- UI utils ---------- */
const $ = id => document.getElementById(id);
function toast(msg, err) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function filterByPeriod(list) {
  if (period === -1) return list.filter(r => (!range.de || r.data >= range.de) && (!range.ate || r.data <= range.ate));
  if (!period) return list;
  const cut = new Date();
  cut.setDate(cut.getDate() - (period - 1));
  const cutISO = isoOf(cut);
  return list.filter(r => r.data >= cutISO);
}
/* janela imediatamente anterior, de mesmo tamanho — para o delta do período */
function janelaAnterior(list) {
  const atual = filterByPeriod(list);
  if (!atual.length) return [];
  const ini = atual[0].data, fim = atual[atual.length - 1].data;
  const dias = Math.round((new Date(fim) - new Date(ini)) / 86400000) + 1;
  const fimPrev = new Date(ini); fimPrev.setDate(fimPrev.getDate() - 1);
  const iniPrev = new Date(fimPrev); iniPrev.setDate(iniPrev.getDate() - (dias - 1));
  const a = isoOf(iniPrev), b = isoOf(fimPrev);
  return list.filter(r => r.data >= a && r.data <= b);
}

/* =================================================================
   Chart.js — base, plugins
================================================================= */
Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
Chart.defaults.font.size = 11.5;
Chart.defaults.color = C.muted;
Chart.defaults.borderColor = C.grid;
/* desenho síncrono: o gráfico aparece na hora ao trocar o filtro e não depende de
   requestAnimationFrame, que não roda com a aba em segundo plano */
Chart.defaults.animation = false;

/* linha de referência horizontal (breakeven, zero) */
const reflinePlugin = {
  id: 'refline',
  afterDatasetsDraw(chart) {
    const opt = chart.options.plugins?.refline;
    if (!opt || opt.y == null) return;
    const { ctx, chartArea, scales } = chart;
    const y = scales.y.getPixelForValue(opt.y);
    if (y < chartArea.top || y > chartArea.bottom) return;
    ctx.save();
    ctx.strokeStyle = opt.color || C.ref;
    if (opt.dash !== false) ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    if (opt.label) {
      ctx.setLineDash([]);
      ctx.fillStyle = C.muted;
      ctx.font = '600 10px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(opt.label, chartArea.right - 2, y - 4);
    }
    ctx.restore();
  },
};

/* anotações verticais (log de mudanças, vindo de `observacoes`) */
const annotPlugin = {
  id: 'xannot',
  afterDatasetsDraw(chart) {
    const marks = chart.options.plugins?.xannot;
    if (!Array.isArray(marks) || !marks.length) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    for (const m of marks) {
      const x = scales.x.getPixelForValue(m.index);
      if (x < chartArea.left || x > chartArea.right) continue;
      ctx.strokeStyle = C.ref;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.fillStyle = C.ref;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x - 4, chartArea.top - 6);
      ctx.lineTo(x + 4, chartArea.top - 6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  },
};

/* rótulos diretos na ponta das barras horizontais.
   Só dados puros nas opções: o Chart.js trata função em `options.plugins.*`
   como scriptable e a chamaria com um contexto interno. */
const endLabelPlugin = {
  id: 'endlabels',
  afterDatasetsDraw(chart) {
    const opt = chart.options.plugins?.endlabels;
    if (!opt || !opt.kind) return;
    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = C.text;
    ctx.font = '600 11.5px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    chart.getDatasetMeta(0).data.forEach((bar, i) => {
      const raw = chart.data.datasets[0].data[i];
      if (raw == null) return;
      let txt;
      if (opt.kind === 'money') txt = fmtBRL(raw);
      else if (opt.kind === 'funil') txt = `${nf0.format(raw)}${opt.topo ? `  ${nf0.format((raw / opt.topo) * 100)}%` : ''}`;
      else txt = nf0.format(raw);
      ctx.fillText(txt, bar.x + 8, bar.y);
    });
    ctx.restore();
  },
};

Chart.register(reflinePlugin, annotPlugin, endLabelPlugin);

function baseOptions(fmt, extra) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: C.card2, borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1,
        titleColor: C.text, bodyColor: C.text2, footerColor: C.muted, padding: 10, cornerRadius: 8,
        boxWidth: 8, boxHeight: 8, boxPadding: 4, usePointStyle: true,
        callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` },
      },
      ...(extra?.plugins || {}),
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
      y: {
        beginAtZero: true,
        grid: { color: ctx => ctx.tick.value === 0 ? C.zero : C.grid, lineWidth: 1 },
        border: { display: false },
        ticks: { callback: v => fmt(v, true), maxTicksLimit: 6 },
        ...(extra?.y || {}),
      },
    },
  };
}
function lineDataset(label, data, color, fillArea, spanGaps) {
  return {
    label, data, borderColor: color, backgroundColor: fillArea ? color + '1a' : color,
    borderWidth: 2, tension: 0.25, fill: !!fillArea, spanGaps: spanGaps !== false,
    pointRadius: 4, pointBackgroundColor: color, pointBorderColor: C.card, pointBorderWidth: 2,
    pointHoverRadius: 6, pointHoverBorderWidth: 2,
  };
}
function barBase(extra) {
  return { borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24, categoryPercentage: 0.65, barPercentage: 0.9, borderColor: C.card, borderWidth: { top: 0, bottom: 0, left: 1, right: 1 }, ...extra };
}
function makeChart(id, cfg) {
  const el = $(id);
  if (!el) return;
  /* se um render anterior falhou no meio, o canvas fica preso a um Chart órfão */
  Chart.getChart(el)?.destroy();
  delete charts[id];
  charts[id] = new Chart(el, cfg);
}
function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

/* anotações a partir de observacoes */
function annotsFrom(list) {
  return list.map((r, i) => r.observacoes ? { index: i, text: r.observacoes } : null).filter(Boolean);
}
function annotFooter(list) {
  return items => {
    const o = list[items[0].dataIndex]?.observacoes;
    return o ? '✎ ' + o : '';
  };
}

/* =================================================================
   Tabela ordenável (um renderizador para as três tabelas)
================================================================= */
function sortRows(list, cols, state, fallbackKey) {
  const col = cols.find(c => c.key === state.key) || cols.find(c => c.key === fallbackKey) || cols[0];
  return [...list].sort((a, b) => {
    const va = col.get(a), vb = col.get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * state.dir;
  });
}

/**
 * @param {object} o { extraHead, rowExtra, onSort, spikeList, rowKey, onRowClick, expandedKey, renderExpand }
 */
function renderSortableTable(tbl, cols, list, state, o = {}) {
  const sorted = sortRows(list, cols, state, cols[0].key);
  const head = '<thead><tr>' + cols.map(c =>
    `<th data-key="${c.key}">${c.label}${state.key === c.key ? ` <span class="arrow">${state.dir === 1 ? '▲' : '▼'}</span>` : ''}</th>`
  ).join('') + (o.extraHead || []).map(h => `<th>${h}</th>`).join('') + '</tr></thead>';

  const ncols = cols.length + (o.extraHead || []).length;
  const body = '<tbody>' + sorted.map(r => {
    const tds = cols.map(c => {
      let cls = c.cls ? c.cls(r) : '';
      if (!cls && c.spike && o.spikeList) cls = spikeClass(o.spikeList.list, o.spikeList.index.get(r.id), c.spike);
      const v = c.fmt(r);
      return `<td class="${v === '—' ? 'dim' : cls}">${v}</td>`;
    }).join('');
    const key = o.rowKey ? o.rowKey(r) : null;
    const open = key != null && key === o.expandedKey;
    const rowCls = (o.onRowClick ? 'clickable' : '') + (open ? ' open' : '');
    const main = `<tr class="${rowCls}"${key != null ? ` data-row="${esc(key)}"` : ''}>${tds}${o.rowExtra ? o.rowExtra(r) : ''}</tr>`;
    if (!open || !o.renderExpand) return main;
    return main + `<tr class="expandrow"><td colspan="${ncols}">${o.renderExpand(r)}</td></tr>`;
  }).join('') + '</tbody>';

  tbl.innerHTML = head + body;

  tbl.querySelectorAll('th[data-key]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.key;
    if (state.key === k) state.dir *= -1; else { state.key = k; state.dir = -1; }
    o.onSort?.();
  }));
  if (o.onRowClick) {
    tbl.querySelectorAll('tr.clickable').forEach(tr => tr.addEventListener('click', e => {
      if (e.target.closest('button')) return;   // botões de linha não disparam o expand
      o.onRowClick(tr.dataset.row);
    }));
  }
  return tbl;
}

/* =================================================================
   VISÃO GERAL — KPIs
================================================================= */
function deltaHtml(cur, prev, upGood, fmt) {
  if (cur == null || prev == null || prev === 0) return `<div class="kdelta">—</div>`;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  let cls = '';
  if (upGood === true) cls = up ? 'up' : 'down';
  else if (upGood === false) cls = up ? 'down' : 'up';
  return `<div class="kdelta ${cls}">${up ? '▲' : '▼'} ${nf2.format(Math.abs(pct))}%</div>`;
}
function kpiCard(label, value, sub, cls, alert) {
  return `<div class="kpi${alert ? ' alert' : ''}">
    <div class="klabel">${label}</div>
    <div class="kvalue ${cls || ''}">${value}</div>
    ${sub || '<div class="kdelta">—</div>'}
  </div>`;
}

function bandKpis(t, tPrev, tag) {
  const lucroCls = t.lucro == null ? '' : (t.lucro >= 0 ? 'good' : 'bad');
  const margemCls = t.margem == null ? '' : (t.margem >= 0 ? 'good' : 'bad');
  const be = breakevenRoas();
  const roasCls = t.roas == null || be == null ? '' : (t.roas >= be ? 'good' : 'bad');
  return [
    kpiCard('Lucro' + tag, fmtBRL(t.lucro), deltaHtml(t.lucro, tPrev?.lucro, true), lucroCls, t.lucro != null && t.lucro < 0),
    kpiCard('Margem', fmtPct(t.margem), deltaHtml(t.margem, tPrev?.margem, true), margemCls),
    kpiCard('ROAS', t.roas == null ? '—' : fmtDec(t.roas), deltaHtml(t.roas, tPrev?.roas, true), roasCls),
    kpiCard(temEconomia() ? 'Receita líquida' : 'Faturamento', fmtBRL(temEconomia() ? t.liquido : t.faturado), deltaHtml(temEconomia() ? t.liquido : t.faturado, temEconomia() ? tPrev?.liquido : tPrev?.faturado, true)),
    kpiCard('Gasto', fmtBRL(t.gasto), deltaHtml(t.gasto, tPrev?.gasto, null)),
  ].join('');
}

function renderKpis() {
  const asc = [...rows].sort((a, b) => a.data.localeCompare(b.data));
  const last = asc[asc.length - 1];
  const prev = asc[asc.length - 2];

  $('ecoHint').textContent = temEconomia()
    ? `descontando ${nf2.format(dedPct())}% de taxa+imposto · breakeven ROAS ${fmtDec(breakevenRoas())}`
    : 'lucro estimado (bruto) — configure a economia do projeto em ⚙';

  $('labelDia').textContent = last ? `Último dia · ${fmtData(last.data)}` : 'Último dia';
  $('kpiDia').innerHTML = last ? bandKpis(totais([last]), prev ? totais([prev]) : null, '') : '<p class="empty">Sem lançamentos.</p>';

  const lista = filterByPeriod(rows);
  const t = totais(lista);
  const tPrev = totais(janelaAnterior(rows));
  $('labelPeriodo').textContent = `Período · ${periodLabel()}${lista.length ? ` · ${lista.length} ${lista.length === 1 ? 'dia' : 'dias'}` : ''}`;
  $('kpiPeriodo').innerHTML = lista.length ? bandKpis(t, tPrev.dias ? tPrev : null, '') : '<p class="empty">Nada no período.</p>';

  /* KPIs de tráfego (recessivos) */
  $('trafSub').textContent = periodLabel();
  const ctr = lista.reduce((s, r) => s + num(r.cliques), 0);
  const cpms = lista.map(r => r.cpm).filter(v => v != null);
  const cpmMed = cpms.length ? cpms.reduce((a, b) => a + b, 0) / cpms.length : null;
  $('kpiTrafego').innerHTML = [
    kpiCard('Cliques', fmtNum(ctr), '<div class="kdelta">no período</div>'),
    kpiCard('CPC', fmtBRL(t.cpc), '<div class="kdelta">gasto ÷ cliques</div>'),
    kpiCard('CPM médio', fmtBRL(cpmMed), '<div class="kdelta">média dos dias</div>'),
    kpiCard('Custo por visualização', fmtBRL(t.custoLp), '<div class="kdelta">tem volume: use como direção</div>'),
    kpiCard('Custo por checkout', fmtBRL(t.custoIc), '<div class="kdelta">tem volume: use como direção</div>'),
    kpiCard('Custo por compra', fmtBRL(t.cpa), `<div class="kdelta">${t.compra} ${t.compra === 1 ? 'compra' : 'compras'} · ruidoso</div>`),
    kpiCard('Ticket líquido', fmtBRL(t.ticket), '<div class="kdelta">receita ÷ compras</div>'),
    kpiCard('Perda de tráfego', fmtPct(t.cliques > 0 ? 100 - t.lpPorClique : null), '<div class="kdelta">clique → página</div>'),
  ].join('');
}

/* ---------- veredito do período ---------- */
function renderVeredito() {
  const lista = filterByPeriod(rows);
  const box = $('veredito');
  if (lista.length < 2) { box.className = 'diag dim'; box.innerHTML = `<div class="diaghead"><span class="verdict dim">Coletando dados</span><span class="vsum">Lance mais dias para o painel conseguir ler tendência.</span></div>`; return; }

  const t = totais(lista);
  const be = breakevenRoas();
  let streak = 0;
  for (let i = lista.length - 1; i >= 0; i--) { const l = lucroOf(lista[i]); if (l != null && l < 0) streak++; else break; }

  let verdict, cls, sum;
  if (t.lucro > 0 && streak === 0) { verdict = 'No lucro'; cls = 'good'; sum = `${fmtBRL(t.lucro)} de lucro em ${lista.length} dias — ROAS ${fmtDec(t.roas)} contra breakeven ${fmtDec(be)}.`; }
  else if (t.lucro > 0) { verdict = 'Atenção'; cls = 'warn'; sum = `Acumulado positivo (${fmtBRL(t.lucro)}), mas os últimos ${streak} ${streak === 1 ? 'dia fechou' : 'dias fecharam'} no vermelho.`; }
  else { verdict = 'No prejuízo'; cls = 'bad'; sum = `${fmtBRL(t.lucro)} no período. ROAS ${fmtDec(t.roas)} está abaixo do breakeven de ${fmtDec(be)}.`; }

  const notes = [];
  if (!temEconomia()) notes.push({ dir: '', html: 'Economia do projeto zerada — o lucro está <b>estimado no bruto</b>. Configure a taxa do gateway em ⚙.' });
  if (t.compra > 0) notes.push({ dir: t.cpa <= (cpaAlvo() ?? Infinity) ? 'up' : 'down', html: `Custo por compra de <b>${fmtBRL(t.cpa)}</b>${cpaAlvo() != null ? ` — o alvo para manter ${nf0.format(num(eco.margem_alvo_pct))}% de margem é ${fmtBRL(cpaAlvo())}` : ''}.` });
  if (t.compra > 0 && t.dias >= 7) {
    const semana = t.compra / (t.dias / 7);
    if (semana < 50) notes.push({ dir: '', html: `~${nf0.format(semana)} conversões por semana: o Meta não sai da <b>fase de aprendizado</b> (precisa de ~50). Evite picotar orçamento entre criativos.` });
  }
  if (t.aprov != null && t.aprov < 80) notes.push({ dir: 'down', html: `Só <b>${fmtPct(t.aprov)}</b> das vendas iniciadas foram aprovadas — o vazamento está no checkout, não no anúncio.` });

  box.className = 'diag ' + cls;
  box.innerHTML = `<div class="diaghead"><span class="verdict ${cls}">${verdict}</span><span class="vsum">${sum}</span></div>
    ${notes.length ? `<ul>${notes.map(n => `<li class="${n.dir}">${n.html}</li>`).join('')}</ul>` : ''}`;
}

/* =================================================================
   VISÃO GERAL — gráficos
================================================================= */
function renderCharts() {
  const list = filterByPeriod(rows);
  const labels = list.map(r => fmtDataCurta(r.data));
  const money = (v, axis) => axis ? 'R$ ' + nf0.format(v) : fmtBRL(v);
  const annots = annotsFrom(list);
  const footer = annotFooter(list);

  /* 1. Lucro por dia — barras divergentes */
  const lucros = list.map(lucroOf);
  const lucroOpts = baseOptions(money, { plugins: { xannot: annots }, y: { beginAtZero: true } });
  lucroOpts.plugins.tooltip.callbacks.footer = footer;
  lucroOpts.onClick = (evt, els) => { if (els.length) toggleDia(list[els[0].index].data); };
  lucroOpts.onHover = (evt, els) => { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; };
  makeChart('chLucro', {
    type: 'bar',
    data: {
      labels,
      datasets: [barBase({
        label: 'Lucro', data: lucros,
        backgroundColor: ctx => num(ctx.raw) >= 0 ? SERIES[0] : C.bad,
        borderSkipped: false,
        borderRadius: ctx => num(ctx.raw) >= 0
          ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 }
          : { topLeft: 0, topRight: 0, bottomLeft: 4, bottomRight: 4 },
      })],
    },
    options: lucroOpts,
  });

  /* 2. Lucro acumulado */
  let acc = 0;
  const acumulado = lucros.map(v => { if (v == null) return null; acc += v; return acc; });
  const acumOpts = baseOptions(money, { plugins: { refline: { y: 0, color: C.zero, dash: false }, xannot: annots }, y: { beginAtZero: false } });
  acumOpts.plugins.tooltip.callbacks.footer = footer;
  makeChart('chLucroAcum', {
    type: 'line',
    data: { labels, datasets: [lineDataset('Lucro acumulado', acumulado, SERIES[0], true, false)] },
    options: acumOpts,
  });

  /* 3. ROAS com breakeven */
  const be = breakevenRoas();
  $('roasSub').textContent = be != null ? `· breakeven ${fmtDec(be)} · alvo ${fmtDec(roasAlvo())}` : '';
  const roasOpts = baseOptions(v => fmtDec(v), {
    plugins: { refline: be != null ? { y: be, label: `breakeven ${fmtDec(be)}` } : {}, xannot: annots },
    y: { suggestedMax: Math.max(1.2, (roasAlvo() || 1.2) * 1.1) },
  });
  roasOpts.plugins.tooltip.callbacks.footer = footer;
  makeChart('chRoas', {
    type: 'line',
    data: { labels, datasets: [lineDataset('ROAS', list.map(roasOf), SERIES[0], true, false)] },
    options: roasOpts,
  });

  /* 4. Gasto vs Faturamento (líquido quando há economia) */
  const usaLiq = temEconomia();
  $('gastoFatTitle').textContent = usaLiq ? 'Gasto vs Receita líquida' : 'Gasto vs Faturamento';
  makeChart('chGastoFat', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        barBase({ label: 'Gasto', data: list.map(r => r.gasto), backgroundColor: SERIES[0] }),
        barBase({ label: usaLiq ? 'Receita líquida' : 'Faturamento', data: list.map(r => usaLiq ? liquidoOf(r) : r.faturado), backgroundColor: SERIES[1] }),
      ],
    },
    options: baseOptions(money, {
      plugins: { legend: { display: true, position: 'top', align: 'end', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, color: C.text2 } } },
    }),
  });
}

/* ---------- Funil (agregado) ---------- */
function renderFunil() {
  const t = totais(filterByPeriod(rows));
  const etapas = [
    { l: 'Cliques', v: t.cliques },
    { l: 'Vis. de página', v: t.lp },
    { l: 'Checkouts iniciados', v: t.ic },
  ];
  const topo = etapas[0].v || 0;

  const funilOpts = {
    indexAxis: 'y',
    responsive: true, maintainAspectRatio: false,
    layout: { padding: { right: 68 } },
    plugins: {
      legend: { display: false },
      endlabels: { kind: 'funil', topo },
      tooltip: {
        backgroundColor: C.card2, borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1,
        titleColor: C.text, bodyColor: C.text2, padding: 10, cornerRadius: 8, displayColors: false,
        callbacks: { label: ctx => ` ${nf0.format(ctx.parsed.x)} — ${topo ? nf0.format((ctx.parsed.x / topo) * 100) : 0}% dos cliques` },
      },
    },
    scales: {
      x: { beginAtZero: true, grid: { color: C.grid }, border: { display: false }, ticks: { maxTicksLimit: 5, callback: v => nf0.format(v) } },
      y: { grid: { display: false }, border: { display: false }, ticks: { color: C.text2, font: { weight: '600' } } },
    },
  };
  makeChart('chFunil', {
    type: 'bar',
    data: {
      labels: etapas.map(e => e.l),
      datasets: [{ label: 'Etapa', data: etapas.map(e => e.v), backgroundColor: RAMP, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24, categoryPercentage: 0.6, barPercentage: 0.9 }],
    },
    options: funilOpts,
  });

  const tiles = [
    { l: 'Clique → página', v: fmtPct(t.lpPorClique) },
    { l: 'Página → checkout', v: fmtPct(t.icPorLp) },
    { l: 'Checkout → compra', v: fmtPct(t.compraPorIc) },
  ];
  $('funilTaxas').innerHTML = tiles.map(x => `<div class="stat"><span class="statl">${x.l}</span><span class="statv">${x.v}</span></div>`).join('');

  /* aprovação do gateway */
  if (!t.temIniciadas || t.iniciadas === 0) {
    $('aprovPct').textContent = '—';
    $('aprovSub').textContent = 'lance “Vendas iniciadas” para medir esta etapa';
    destroyChart('chAprov');
    $('chAprov').getContext('2d').clearRect(0, 0, $('chAprov').width, $('chAprov').height);
    return;
  }
  const naoAprov = Math.max(0, t.iniciadas - t.compra);
  $('aprovPct').textContent = fmtPct(t.aprov);
  $('aprovSub').textContent = `${nf0.format(t.compra)} de ${nf0.format(t.iniciadas)} vendas iniciadas foram aprovadas`;
  makeChart('chAprov', {
    type: 'bar',
    data: {
      labels: [''],
      datasets: [
        { label: 'Aprovadas', data: [t.compra], backgroundColor: SERIES[0], borderRadius: { topLeft: 4, bottomLeft: 4 }, borderSkipped: false, maxBarThickness: 24, borderColor: C.card, borderWidth: { right: 1 } },
        { label: 'Não aprovadas', data: [naoAprov], backgroundColor: C.grid, borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: false, maxBarThickness: 24 },
      ],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, color: C.text2 } },
        tooltip: { backgroundColor: C.card2, borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1, titleColor: C.text, bodyColor: C.text2, padding: 10, cornerRadius: 8, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${nf0.format(ctx.parsed.x)}` } },
      },
      scales: {
        x: { stacked: true, display: false, beginAtZero: true },
        y: { stacked: true, display: false },
      },
    },
  });
}

/* =================================================================
   VISÃO GERAL — tabela de dias + expand (ponte para os anúncios)
================================================================= */
const COLS_GERAL = [
  { key: 'data', label: 'Data', get: r => r.data, fmt: r => `<span class="expandcue">${expandedDia === r.data ? '▾' : '▸'}</span> ${fmtData(r.data)}` },
  { key: 'lucro', label: 'Lucro', get: r => lucroOf(r), fmt: r => fmtBRL(lucroOf(r)), cls: r => { const v = lucroOf(r); return v == null ? '' : (v >= 0 ? 'good' : 'bad'); } },
  { key: 'margem', label: 'Margem', get: r => margemOf(r), fmt: r => fmtPct(margemOf(r)), cls: r => { const v = margemOf(r); return v == null ? '' : (v >= 0 ? 'good' : 'bad'); } },
  { key: 'gasto', label: 'Gasto', get: r => r.gasto, fmt: r => fmtBRL(r.gasto) },
  { key: 'faturado', label: 'Faturado', get: r => r.faturado, fmt: r => fmtBRL(r.faturado) },
  { key: 'liquido', label: 'Líquido', get: r => liquidoOf(r), fmt: r => fmtBRL(liquidoOf(r)) },
  { key: 'roas', label: 'ROAS', get: r => roasOf(r), fmt: r => roasOf(r) == null ? '—' : fmtDec(roasOf(r)), cls: r => { const v = roasOf(r), be = breakevenRoas(); return v == null || be == null ? '' : (v >= be ? 'good' : 'bad'); } },
  { key: 'compra', label: 'Compras', get: r => r.compra, fmt: r => fmtNum(r.compra) },
  { key: 'cpa', label: 'Custo/Compra', get: r => cpaDiaOf(r), fmt: r => fmtBRL(cpaDiaOf(r)) },
  { key: 'taxa', label: 'Conv. Checkout', get: r => taxaOf(r), fmt: r => fmtPct(taxaOf(r)) },
  { key: 'finalizacao_compra', label: 'Checkouts', get: r => r.finalizacao_compra, fmt: r => fmtNum(r.finalizacao_compra) },
  { key: 'vendas_iniciadas', label: 'Vendas inic.', get: r => r.vendas_iniciadas, fmt: r => fmtNum(r.vendas_iniciadas) },
  { key: 'cpc', label: 'CPC', get: r => r.cpc, fmt: r => fmtBRL(r.cpc), spike: 'cpc' },
  { key: 'cpm', label: 'CPM', get: r => r.cpm, fmt: r => fmtBRL(r.cpm), spike: 'cpm' },
  { key: 'cliques', label: 'Cliques', get: r => r.cliques, fmt: r => fmtNum(r.cliques) },
  { key: 'visualizacao_destino', label: 'Vis. Página', get: r => r.visualizacao_destino, fmt: r => fmtNum(r.visualizacao_destino) },
  { key: 'perda_trafego', label: 'Perda Tráf.', get: r => perdaOf(r), fmt: r => fmtPct(perdaOf(r)), cls: r => { const v = perdaOf(r); return v != null && v > settings.perdaMax ? 'bad' : ''; } },
];

function expandDiaHtml(r) {
  const doDia = adRows.filter(a => a.data === r.data).sort((a, b) => num(b.gasto) - num(a.gasto));
  if (!doDia.length) {
    return `<div class="diabox">
      <p class="empty" style="padding:6px 0">Nenhum anúncio detalhado neste dia.</p>
      <button class="btn ghost small" data-novoad="${r.data}">＋ Lançar anúncio deste dia</button>
    </div>`;
  }
  const gastoAds = doDia.reduce((s, a) => s + num(a.gasto), 0);
  const cobertura = num(r.gasto) > 0 ? (gastoAds / num(r.gasto)) * 100 : null;

  const linhas = doDia.map(a => `<tr>
    <td>${esc(a.anuncio)}</td>
    <td>${fmtBRL(a.gasto)}</td>
    <td>${fmtBRL(a.faturado)}</td>
    <td class="${(() => { const v = adRoasOf(a), be = breakevenRoas(); return v == null || be == null ? '' : (v >= be ? 'good' : 'bad'); })()}">${adRoasOf(a) == null ? '—' : fmtDec(adRoasOf(a))}</td>
    <td>${fmtNum(a.compras)}</td>
    <td class="${adLucroOf(a) == null ? 'dim' : (adLucroOf(a) >= 0 ? 'good' : 'bad')}">${fmtBRL(adLucroOf(a))}</td>
    <td><button class="rowbtn" data-ana="${esc(a.anuncio)}" title="Analisar este anúncio">Analisar →</button></td>
  </tr>`).join('');

  return `<div class="diabox">
    <div class="diagrid">
      <div>
        <h4>Gasto por anúncio</h4>
        <div class="chartbox diachart"><canvas id="chDiaAds"></canvas></div>
      </div>
      <div>
        <h4>Anúncios de ${fmtData(r.data)}</h4>
        <div class="tablewrap"><table class="subtable">
          <thead><tr><th>Anúncio</th><th>Gasto</th><th>Faturado</th><th>ROAS</th><th>Compras</th><th>Lucro</th><th></th></tr></thead>
          <tbody>${linhas}</tbody>
        </table></div>
      </div>
    </div>
    <p class="cobertura">Os anúncios lançados cobrem ${fmtBRL(gastoAds)} dos ${fmtBRL(r.gasto)} de gasto do dia${cobertura != null ? ` (${nf0.format(cobertura)}%)` : ''}.</p>
  </div>`;
}

function drawDiaChart(diaISO) {
  const doDia = adRows.filter(a => a.data === diaISO).sort((a, b) => num(b.gasto) - num(a.gasto));
  if (!doDia.length || !$('chDiaAds')) return;
  let itens = doDia.map(a => ({ l: a.anuncio, v: num(a.gasto) }));
  if (itens.length > 8) {
    const resto = itens.slice(8).reduce((s, x) => s + x.v, 0);
    itens = itens.slice(0, 8).concat([{ l: 'Outros', v: resto }]);
  }
  makeChart('chDiaAds', {
    type: 'bar',
    data: { labels: itens.map(i => i.l), datasets: [{ label: 'Gasto', data: itens.map(i => i.v), backgroundColor: SERIES[0], borderRadius: 4, borderSkipped: 'start', maxBarThickness: 20, categoryPercentage: 0.7 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 60 } },
      plugins: {
        legend: { display: false },
        endlabels: { kind: 'money' },
        tooltip: { backgroundColor: C.card2, borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1, titleColor: C.text, bodyColor: C.text2, padding: 10, cornerRadius: 8, displayColors: false, callbacks: { label: ctx => ' ' + fmtBRL(ctx.parsed.x) } },
      },
      scales: {
        x: { beginAtZero: true, grid: { color: C.grid }, border: { display: false }, ticks: { maxTicksLimit: 4, callback: v => 'R$ ' + nf0.format(v) } },
        y: { grid: { display: false }, border: { display: false }, ticks: { color: C.text2 } },
      },
    },
  });
}

function toggleDia(diaISO) {
  destroyChart('chDiaAds');
  expandedDia = expandedDia === diaISO ? null : diaISO;
  renderTableGeral();
  if (expandedDia) {
    drawDiaChart(expandedDia);
    document.querySelector(`#tblGeral tr[data-row="${expandedDia}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderTableGeral() {
  const tbl = $('tblGeral');
  const list = filterByPeriod(rows);
  $('emptyGeral').classList.toggle('hidden', list.length > 0);
  if (!list.length) { tbl.innerHTML = ''; destroyChart('chDiaAds'); return; }

  const asc = [...rows].sort((a, b) => a.data.localeCompare(b.data));
  const spikeList = { list: asc, index: new Map(asc.map((r, i) => [r.id, i])) };

  renderSortableTable(tbl, COLS_GERAL, list, sortGeral, {
    extraHead: ['Obs', ''],
    spikeList,
    rowKey: r => r.data,
    expandedKey: expandedDia,
    renderExpand: expandDiaHtml,
    onRowClick: toggleDia,
    onSort: () => { renderTableGeral(); if (expandedDia) drawDiaChart(expandedDia); },
    rowExtra: r => `<td class="dim obscell">${esc(r.observacoes || '')}</td>
      <td><div class="rowbtns">
        <button class="rowbtn" data-edit="${r.id}" title="Editar">✎</button>
        <button class="rowbtn del" data-del="${r.id}" title="Excluir">🗑</button>
      </div></td>`,
  });

  tbl.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => startEditGeral(b.dataset.edit)));
  tbl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => delGeral(b.dataset.del)));
  tbl.querySelectorAll('[data-ana]').forEach(b => b.addEventListener('click', () => irParaAnalise(b.dataset.ana)));
  tbl.querySelectorAll('[data-novoad]').forEach(b => b.addEventListener('click', () => {
    trocarAba('anuncios');
    resetFormAds();
    $('a_data').value = b.dataset.novoad;
    $('formCardAds').open = true;
    $('formCardAds').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  ajustarDiabox();
  if (expandedDia) drawDiaChart(expandedDia);
}

/* o painel do expand vive num <td colspan> tão largo quanto a tabela;
   fixamos a largura na área visível para não obrigar a rolar de lado no celular */
function ajustarDiabox() {
  const box = $('tblGeral').querySelector('.diabox');
  if (!box) return;
  const wrap = $('tblGeral').closest('.tablewrap');
  box.style.width = wrap.clientWidth + 'px';
}

function irParaAnalise(nome) {
  trocarAba('anuncios');
  $('anaAd').value = nome;
  renderAnalise();
  $('anaCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---- form Visão Geral ---- */
function startEditGeral(id) {
  const r = rows.find(x => x.id === id);
  if (!r) return;
  editingId = id;
  $('f_data').value = r.data;
  $('f_gasto').value = numToInput(r.gasto);
  $('f_faturado').value = numToInput(r.faturado);
  $('f_compra').value = numToInput(r.compra);
  $('f_cliques').value = numToInput(r.cliques);
  $('f_visualizacao').value = numToInput(r.visualizacao_destino);
  $('f_finalizacao').value = numToInput(r.finalizacao_compra);
  $('f_cpm').value = numToInput(r.cpm);
  $('f_cpc').value = numToInput(r.cpc);
  $('f_perda').value = numToInput(r.perda_trafego);
  $('f_iniciadas').value = numToInput(r.vendas_iniciadas);
  $('f_liquido').value = numToInput(r.faturamento_liquido);
  $('f_despesas').value = numToInput(r.despesas_adicionais);
  $('f_reembolso').value = numToInput(r.vendas_reembolsadas);
  $('f_chargeback').value = numToInput(r.vendas_chargeback);
  $('f_pendentes').value = numToInput(r.vendas_pendentes);
  $('f_frontend').value = numToInput(r.valor_compras_frontend);
  $('f_backend').value = numToInput(r.valor_compras_backend);
  $('f_taxa').value = numToInput(r.taxa_conversao_checkout);
  $('f_roi').value = numToInput(r.roi);
  $('f_obs').value = r.observacoes || '';
  $('formCardGeral').open = true;
  $('editTagGeral').classList.remove('hidden');
  $('btnCancelGeral').classList.remove('hidden');
  $('btnSalvarGeral').textContent = 'Salvar alterações';
  updatePreviewsGeral();
  $('formCardGeral').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function resetFormGeral() {
  editingId = null;
  $('formGeral').reset();
  $('f_data').value = todayISO();
  $('editTagGeral').classList.add('hidden');
  $('btnCancelGeral').classList.add('hidden');
  $('btnSalvarGeral').textContent = 'Salvar dia';
  updatePreviewsGeral();
}
function collectGeral() {
  return {
    data: $('f_data').value,
    campanha: projeto,
    gasto: parseNum($('f_gasto').value),
    faturado: parseNum($('f_faturado').value),
    compra: parseInt0($('f_compra').value),
    cliques: parseInt0($('f_cliques').value),
    visualizacao_destino: parseInt0($('f_visualizacao').value),
    finalizacao_compra: parseInt0($('f_finalizacao').value),
    cpm: parseNum($('f_cpm').value),
    cpc: parseNum($('f_cpc').value),
    perda_trafego: parseNum($('f_perda').value),
    vendas_iniciadas: parseInt0($('f_iniciadas').value),
    faturamento_liquido: parseNum($('f_liquido').value),
    despesas_adicionais: parseNum($('f_despesas').value),
    vendas_reembolsadas: parseNum($('f_reembolso').value),
    vendas_chargeback: parseNum($('f_chargeback').value),
    vendas_pendentes: parseNum($('f_pendentes').value),
    valor_compras_frontend: parseNum($('f_frontend').value),
    valor_compras_backend: parseNum($('f_backend').value),
    taxa_conversao_checkout: parseNum($('f_taxa').value),
    roi: parseNum($('f_roi').value),
    observacoes: $('f_obs').value.trim() || null,
  };
}
function updatePreviewsGeral() {
  const rec = collectGeral();
  const gasto = rec.gasto, fat = rec.faturado;
  $('f_roi').placeholder = (gasto > 0 && fat != null) ? 'auto: ' + nf2.format(fat / gasto) : 'auto';
  $('f_taxa').placeholder = (rec.finalizacao_compra > 0 && rec.compra != null) ? 'auto: ' + nf2.format((rec.compra / rec.finalizacao_compra) * 100) + '%' : 'auto';
  $('f_perda').placeholder = (rec.cliques > 0 && rec.visualizacao_destino != null) ? 'auto: ' + nf2.format(((rec.cliques - rec.visualizacao_destino) / rec.cliques) * 100) + '%' : 'auto';
  $('f_liquido').placeholder = (fat != null && temEconomia()) ? 'auto: ' + nf2.format(fat * (1 - dedPct() / 100)) : 'auto';

  const l = lucroOf(rec);
  if (l == null) { $('previewDia').textContent = `Lançando no projeto ${projeto}.`; return; }
  const m = margemOf(rec), ro = roasOf(rec);
  $('previewDia').innerHTML = `No projeto <b>${esc(projeto)}</b> · lucro <b class="${l >= 0 ? 'up' : 'down'}">${fmtBRL(l)}</b>${m != null ? ` · margem ${fmtPct(m)}` : ''}${ro != null ? ` · ROAS ${fmtDec(ro)}` : ''}${temEconomia() ? '' : ' (bruto)'}`;
}

/* somar os anúncios daquele dia no form */
function somarDosAnuncios() {
  const dia = $('f_data').value;
  if (!dia) return toast('Escolha a data primeiro.', true);
  const doDia = adRows.filter(a => a.data === dia);
  if (!doDia.length) return toast(`Nenhum anúncio lançado em ${fmtData(dia)}.`, true);
  const s = doDia.reduce((acc, a) => ({
    gasto: acc.gasto + num(a.gasto), faturado: acc.faturado + num(a.faturado),
    compras: acc.compras + num(a.compras), cliques: acc.cliques + num(a.cliques),
  }), { gasto: 0, faturado: 0, compras: 0, cliques: 0 });
  $('f_gasto').value = numToInput(Number(s.gasto.toFixed(2)));
  $('f_faturado').value = numToInput(Number(s.faturado.toFixed(2)));
  $('f_compra').value = String(s.compras);
  if (s.cliques) $('f_cliques').value = String(s.cliques);
  updatePreviewsGeral();
  toast(`Somados ${doDia.length} ${doDia.length === 1 ? 'anúncio' : 'anúncios'} de ${fmtData(dia)} ✓`);
}

async function saveGeral(e) {
  e.preventDefault();
  const rec = collectGeral();
  if (!rec.data) return toast('Escolha a data.', true);
  $('btnSalvarGeral').disabled = true;
  try {
    if (editingId) {
      const { error } = await db.from('ads_metricas_diarias').update(rec).eq('id', editingId);
      if (error) throw error;
      toast('Dia atualizado ✓');
    } else {
      const dup = rows.find(r => r.data === rec.data);
      if (dup && !confirm(`Já existe lançamento em ${fmtData(rec.data)}. Sobrescrever?`)) { $('btnSalvarGeral').disabled = false; return; }
      const { error } = await db.from('ads_metricas_diarias').upsert(rec, { onConflict: 'data,campanha' });
      if (error) throw error;
      toast('Dia lançado ✓');
    }
    resetFormGeral();
    await loadData();
  } catch (err) {
    toast('Erro ao salvar: ' + (err.message || err), true);
  }
  $('btnSalvarGeral').disabled = false;
}
async function delGeral(id) {
  const r = rows.find(x => x.id === id);
  if (!r || !confirm(`Excluir o dia ${fmtData(r.data)}?`)) return;
  const { error } = await db.from('ads_metricas_diarias').delete().eq('id', id);
  if (error) return toast('Erro ao excluir: ' + error.message, true);
  if (editingId === id) resetFormGeral();
  if (expandedDia === r.data) { expandedDia = null; destroyChart('chDiaAds'); }
  toast('Dia excluído');
  await loadData();
}

/* =================================================================
   ANÚNCIOS
================================================================= */
function adColorMap() {
  const order = [];
  for (const r of adRows) if (!order.includes(r.anuncio)) order.push(r.anuncio);
  const map = {};
  order.forEach((name, i) => { map[name] = SERIES[i % SERIES.length]; });
  return map;
}
function adNames() { return [...new Set(adRows.map(r => r.anuncio))]; }

function renderAdDatalist() {
  $('adNames').innerHTML = adNames().map(n => `<option value="${esc(n)}">`).join('');
  const sel = $('histAdFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todos os anúncios</option>' + adNames().map(n => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

const MIN_CONV = 10;   // abaixo disso, ROAS de criativo é ruído

const COLS_RANK = [
  { key: 'anuncio', label: 'Anúncio', get: a => a.anuncio.toLowerCase(), fmt: a => `<button class="adlink" data-ana="${esc(a.anuncio)}" title="Analisar este anúncio"><span class="dot" style="background:${a.color}"></span>${esc(a.anuncio)}</button>${a.compras < MIN_CONV ? '<span class="badge small">amostra pequena</span>' : ''}` },
  { key: 'lucro', label: 'Lucro', get: a => a.lucro, fmt: a => fmtBRL(a.lucro), cls: a => a.lucro == null ? '' : (a.lucro >= 0 ? 'good' : 'bad') },
  { key: 'status', label: 'Status', get: a => a.status, fmt: a => `<span class="badge ${a.status}">${a.status}</span>` },
  { key: 'gasto', label: 'Gasto', get: a => a.gasto, fmt: a => fmtBRL(a.gasto) },
  { key: 'faturado', label: 'Faturado', get: a => a.faturado, fmt: a => fmtBRL(a.faturado) },
  { key: 'compras', label: 'Compras', get: a => a.compras, fmt: a => fmtNum(a.compras) },
  { key: 'roas', label: 'ROAS', get: a => a.roas, fmt: a => a.roas == null ? '—' : fmtDec(a.roas), cls: a => { const be = breakevenRoas(); return a.roas == null || be == null ? '' : (a.roas >= be ? 'good' : 'bad'); } },
  { key: 'cpa', label: 'Custo/Compra', get: a => a.cpa, fmt: a => fmtBRL(a.cpa) },
  { key: 'ctr', label: 'CTR méd.', get: a => a.ctr, fmt: a => fmtPct(a.ctr) },
  { key: 'cpc', label: 'CPC méd.', get: a => a.cpc, fmt: a => fmtBRL(a.cpc) },
  { key: 'hook', label: 'Hook méd.', get: a => a.hook, fmt: a => fmtPct(a.hook) },
  { key: 'dias', label: 'Dias', get: a => a.dias, fmt: a => fmtNum(a.dias) },
];

function aggregateAds(list) {
  const src = list || filterByPeriod(adRows);
  const colors = adColorMap();
  const byAd = {};
  for (const r of src) {
    const a = byAd[r.anuncio] || (byAd[r.anuncio] = { anuncio: r.anuncio, color: colors[r.anuncio], gasto: 0, faturado: 0, compras: 0, ctrs: [], cpcs: [], hooks: [], dias: 0, lastData: '', status: 'ativo' });
    a.dias++;
    a.gasto += num(r.gasto); a.faturado += num(r.faturado); a.compras += num(r.compras);
    if (r.ctr != null) a.ctrs.push(Number(r.ctr));
    if (r.cpc != null) a.cpcs.push(Number(r.cpc));
    if (r.hook_rate != null) a.hooks.push(Number(r.hook_rate));
    if (r.data >= a.lastData) { a.lastData = r.data; a.status = r.status; }
  }
  const media = arr => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null;
  return Object.values(byAd).map(a => ({
    ...a,
    roas: a.gasto > 0 ? a.faturado / a.gasto : null,
    cpa: a.compras > 0 ? a.gasto / a.compras : null,
    lucro: a.faturado * (1 - dedPct() / 100) - a.gasto - num(eco.custo_por_venda) * a.compras,
    ctr: media(a.ctrs), cpc: media(a.cpcs), hook: media(a.hooks),
  }));
}

function renderRanking() {
  const tbl = $('tblRanking');
  const ags = aggregateAds();
  $('rankPeriodo').textContent = '· ' + periodLabel();
  $('emptyRanking').classList.toggle('hidden', ags.length > 0);
  if (!ags.length) { tbl.innerHTML = ''; return; }

  renderSortableTable(tbl, COLS_RANK, ags, sortRank, {
    extraHead: [''],
    onSort: renderRanking,
    rowExtra: a => `<td><div class="rowbtns">
      <button class="rowbtn del" data-delad="${esc(a.anuncio)}" title="Excluir o anúncio e todos os dias dele">🗑</button>
    </div></td>`,
  });

  tbl.querySelectorAll('[data-delad]').forEach(b => b.addEventListener('click', () => excluirAnuncio(b.dataset.delad)));
  tbl.querySelectorAll('[data-ana]').forEach(b => b.addEventListener('click', () => irParaAnalise(b.dataset.ana)));
}

/* =================================================================
   ANÁLISE DE UM ANÚNCIO
================================================================= */
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

function trendPct(list, fn) {
  const vals = list.map(fn).filter(v => v != null);
  if (vals.length < 4) return null;
  const k = Math.floor(vals.length / 2);
  const early = avg(vals.slice(0, vals.length - k));
  const recent = avg(vals.slice(-k));
  if (!early) return null;
  return ((recent - early) / Math.abs(early)) * 100;
}

/**
 * Veredito honesto. O gate é GASTO ACUMULADO, não dias de calendário:
 * zero venda com R$ 8 gastos é o estado esperado, não um criativo morto.
 */
function diagnose(days) {
  const gasto = days.reduce((s, r) => s + num(r.gasto), 0);
  const faturado = days.reduce((s, r) => s + num(r.faturado), 0);
  const compras = days.reduce((s, r) => s + num(r.compras), 0);
  const lucro = faturado * (1 - dedPct() / 100) - gasto - num(eco.custo_por_venda) * compras;
  const roas = gasto > 0 ? faturado / gasto : null;
  const status = days[days.length - 1].status;
  const be = breakevenRoas();
  const alvo = roasAlvo();
  const gate = cpaAlvo();
  const cliques = days.reduce((s, r) => s + num(r.cliques), 0);

  const notes = [];
  const tRoas = trendPct(days, adRoasOf);
  const tCpc = trendPct(days, r => r.cpc);
  const tFreq = trendPct(days, r => r.frequencia);
  const freqs = days.map(r => r.frequencia).filter(v => v != null);
  const lastFreq = freqs.length ? freqs[freqs.length - 1] : null;
  const hooks = days.map(r => r.hook_rate).filter(v => v != null);
  const hookAvg = hooks.length ? avg(hooks) : null;

  const recentes = days.slice(-3).map(adRoasOf).filter(v => v != null);
  const roasRecente = recentes.length ? avg(recentes) : null;
  const desgastando = (tRoas != null && tRoas < -25) || (lastFreq != null && lastFreq >= 2.5);
  const amostraPequena = compras < MIN_CONV;

  let verdict, vClass, vSum;

  if (compras === 0) {
    if (gate != null && gasto >= gate * 1.5) {
      verdict = 'Cortar'; vClass = 'bad';
      vSum = `${fmtBRL(gasto)} gastos e nenhuma compra — já passou de 1,5× o custo por compra alvo (${fmtBRL(gate)}).`;
    } else {
      verdict = 'Coletando dados'; vClass = 'dim';
      vSum = gate != null
        ? `${fmtBRL(gasto)} gastos, sem venda ainda. Zero venda é normal até ~${fmtBRL(gate)} — espere antes de julgar.`
        : `${fmtBRL(gasto)} gastos, sem venda ainda. Sem histórico de vendas o painel não sabe qual custo por compra esperar.`;
    }
  } else if (roas == null || be == null) {
    verdict = 'Coletando dados'; vClass = 'dim';
    vSum = 'Faltam gasto/faturado para avaliar este criativo.';
  } else if (roasRecente != null && days.length >= 3 && roasRecente < be && roas >= be) {
    verdict = 'Cortar'; vClass = 'bad';
    vSum = `Acumulado ainda positivo (ROAS ${fmtDec(roas)}), mas os últimos ${recentes.length} dias rodaram a ${fmtDec(roasRecente)} — abaixo do breakeven de ${fmtDec(be)}. Está queimando dinheiro agora.`;
  } else if (roas < be) {
    if (gate != null && gasto >= gate * 3) { verdict = 'Cortar'; vClass = 'bad'; vSum = `ROAS de ${fmtDec(roas)} contra breakeven ${fmtDec(be)} — ${fmtBRL(Math.abs(lucro))} de prejuízo em ${fmtBRL(gasto)} gastos.`; }
    else { verdict = 'Testar novo criativo'; vClass = 'warn'; vSum = `ROAS de ${fmtDec(roas)} está abaixo do breakeven (${fmtDec(be)}). Ainda pouco gasto para condenar — mas prepare a próxima variação.`; }
  } else if (desgastando) {
    verdict = 'Testar novo criativo'; vClass = 'warn';
    vSum = `ROAS de ${fmtDec(roas)} ainda paga a conta, mas o criativo dá sinais de desgaste — tenha a próxima variação pronta.`;
  } else if (alvo != null && roas >= alvo && !amostraPequena) {
    verdict = 'Escalar'; vClass = 'good';
    vSum = `ROAS de ${fmtDec(roas)} acima do alvo (${fmtDec(alvo)}) com ${compras} conversões — dá para subir orçamento.`;
  } else {
    verdict = 'Manter'; vClass = 'good';
    vSum = `ROAS de ${fmtDec(roas)} acima do breakeven (${fmtDec(be)})${amostraPequena ? `, mas com só ${compras} ${compras === 1 ? 'conversão' : 'conversões'} — amostra pequena demais para escalar` : ''}.`;
  }

  if (amostraPequena && compras > 0) notes.unshift({ dir: '', html: `<b>${compras} ${compras === 1 ? 'conversão' : 'conversões'}</b> acumuladas: abaixo de ${MIN_CONV} o ROAS de um criativo oscila demais para decidir escala.` });
  if (roasRecente != null && days.length >= 3) notes.push({ dir: be != null && roasRecente >= be ? 'up' : 'down', html: `Últimos ${recentes.length} dias rodaram a ROAS <b>${fmtDec(roasRecente)}</b> (acumulado: ${fmtDec(roas)}).` });
  if (tRoas != null) notes.push({ dir: tRoas >= 0 ? 'up' : 'down', html: `ROAS ${tRoas >= 0 ? 'subindo' : 'caindo'}: <b>${tRoas >= 0 ? '+' : ''}${nf2.format(tRoas)}%</b> nos dias recentes vs os primeiros.` });
  if (tCpc != null && tCpc > 15) notes.push({ dir: 'down', html: `CPC subiu <b>${nf2.format(tCpc)}%</b> — o clique está ficando mais caro.` });
  if (tCpc != null && tCpc < -15) notes.push({ dir: 'up', html: `CPC caiu <b>${nf2.format(Math.abs(tCpc))}%</b> — clique mais barato.` });
  if (lastFreq != null && lastFreq >= 2.5) notes.push({ dir: 'down', html: `Frequência em <b>${nf2.format(lastFreq)}</b> — o mesmo público está vendo demais (fadiga de criativo).` });
  else if (tFreq != null && tFreq > 25) notes.push({ dir: 'down', html: `Frequência subindo <b>${nf2.format(tFreq)}%</b> — fique de olho na fadiga.` });
  if (hookAvg != null && hookAvg < 20) notes.push({ dir: 'down', html: `Hook rate médio de <b>${nf2.format(hookAvg)}%</b> — os 3 primeiros segundos não estão segurando.` });
  else if (hookAvg != null && hookAvg >= 30) notes.push({ dir: 'up', html: `Hook rate médio de <b>${nf2.format(hookAvg)}%</b> — a abertura do criativo prende bem.` });
  if (compras === 0 && cliques > 0) notes.push({ dir: '', html: `<b>${nf0.format(cliques)} cliques</b> sem compra — amostra em cliques, não em dias de calendário.` });
  if (compras > 0 && gasto > 0) notes.push({ dir: gate != null && gasto / compras <= gate ? 'up' : 'down', html: `Custo por compra de <b>${fmtBRL(gasto / compras)}</b>${gate != null ? ` (alvo: ${fmtBRL(gate)})` : ''}.` });
  if (days.length >= 7) {
    const semana = compras / (days.length / 7);
    if (semana < 50) notes.push({ dir: '', html: `~${nf0.format(semana)} conversões/semana: o Meta segue em <b>fase de aprendizado</b>. Cada mudança de orçamento reinicia o aprendizado.` });
  }
  if (status === 'pausado') notes.push({ dir: 'down', html: 'Anúncio marcado como <b>pausado</b> no último lançamento.' });

  return { verdict, vClass, vSum, notes, gasto, faturado, compras, roas, roasRecente, lucro };
}

function renderAnaKpis(d, days) {
  const nComp = `${d.compras} ${d.compras === 1 ? 'compra' : 'compras'}`;
  const be = breakevenRoas();
  const roasSub = d.roasRecente == null
    ? (be != null ? 'breakeven: ' + fmtDec(be) : '—')
    : `<span class="${be != null && d.roasRecente >= be ? 'up' : 'down'}">recente: ${fmtDec(d.roasRecente)}</span>`;

  $('anaKpis').innerHTML = [
    { l: 'Lucro', v: fmtBRL(d.lucro), cls: d.lucro >= 0 ? 'good' : 'bad', sub: temEconomia() ? `líquido de ${nf2.format(dedPct())}%` : 'estimado (bruto)' },
    { l: 'Gasto total', v: fmtBRL(d.gasto), sub: `em ${days.length} ${days.length === 1 ? 'dia' : 'dias'}` },
    { l: 'ROAS acumulado', v: d.roas == null ? '—' : fmtDec(d.roas), cls: d.roas == null || be == null ? '' : (d.roas >= be ? 'good' : 'bad'), sub: roasSub },
    { l: 'Custo por compra', v: d.compras > 0 ? fmtBRL(d.gasto / d.compras) : '—', sub: nComp },
    { l: 'Dias rodando', v: `${days.length}`, sub: `${fmtDataCurta(days[0].data)} → ${fmtDataCurta(days[days.length - 1].data)}` },
  ].map(k => `<div class="kpi">
      <div class="klabel">${k.l}</div>
      <div class="kvalue ${k.cls || ''}">${k.v}</div>
      <div class="kdelta">${k.sub}</div>
    </div>`).join('');
}

function renderAnaDiag(d) {
  $('anaDiag').className = 'diag ' + d.vClass;
  $('anaDiag').innerHTML = `
    <div class="diaghead">
      <span class="verdict ${d.vClass}">${d.verdict}</span>
      <span class="vsum">${d.vSum}</span>
    </div>
    ${d.notes.length ? `<ul>${d.notes.map(n => `<li class="${n.dir}">${n.html}</li>`).join('')}</ul>` : ''}
    <p class="diagfoot">Leitura automática dos seus números — use como sinal, não como ordem.</p>`;
}

function miniOptions(days, fmt, extra) {
  const o = baseOptions(fmt, extra);
  o.plugins.tooltip.callbacks.title = items => `Dia ${items[0].dataIndex + 1} · ${fmtData(days[items[0].dataIndex].data)}`;
  o.plugins.tooltip.callbacks.footer = annotFooter(days);
  o.plugins.xannot = annotsFrom(days);
  o.scales.y.ticks.maxTicksLimit = 4;
  return o;
}

function renderAnaCharts(days) {
  const labels = days.map((_, i) => 'D' + (i + 1));
  const money = (v, axis) => axis ? 'R$ ' + nf0.format(v) : fmtBRL(v);
  const money2 = (v, axis) => axis ? 'R$ ' + nf2.format(v) : fmtBRL(v);
  const pct = (v, axis) => axis ? nf0.format(v) + '%' : fmtPct(v);

  let acc = 0;
  const lucroAcum = days.map(r => { const v = adLucroOf(r); if (v == null) return null; acc += v; return acc; });
  makeChart('anaLucro', {
    type: 'line',
    data: { labels, datasets: [lineDataset('Lucro acumulado', lucroAcum, SERIES[0], true, false)] },
    options: miniOptions(days, money, { plugins: { refline: { y: 0, color: C.zero, dash: false } }, y: { beginAtZero: false } }),
  });

  const gastoOpts = miniOptions(days, money);
  gastoOpts.plugins.legend = { display: true, position: 'top', align: 'end', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, color: C.text2, font: { size: 10 } } };
  makeChart('anaGasto', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        barBase({ label: 'Gasto', data: days.map(r => r.gasto), backgroundColor: SERIES[0], maxBarThickness: 18 }),
        barBase({ label: 'Faturado', data: days.map(r => r.faturado), backgroundColor: SERIES[1], maxBarThickness: 18 }),
      ],
    },
    options: gastoOpts,
  });

  makeChart('anaCpc', { type: 'line', data: { labels, datasets: [lineDataset('CPC', days.map(r => r.cpc), SERIES[0], true, false)] }, options: miniOptions(days, money2) });
  makeChart('anaHook', { type: 'line', data: { labels, datasets: [lineDataset('Hook Rate', days.map(r => r.hook_rate), SERIES[0], true, false)] }, options: miniOptions(days, pct) });
  makeChart('anaFreq', { type: 'line', data: { labels, datasets: [lineDataset('Frequência', days.map(r => r.frequencia), SERIES[0], true, false)] }, options: miniOptions(days, v => fmtDec(v)) });
}

function deltaTag(cur, prev, upGood) {
  if (prev == null || prev === 0 || cur == null) return '';
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.05) return '';
  const up = pct > 0;
  const cls = upGood === null ? '' : (up === upGood ? 'up' : 'down');
  return `<span class="delta ${cls}">${up ? '▲' : '▼'}${nf0.format(Math.abs(pct))}%</span>`;
}
function cellWithDelta(fmtVal, cur, prev, upGood, extraCls) {
  if (cur == null) return '<td class="dim">—</td>';
  return `<td class="${extraCls || ''}">${fmtVal}${deltaTag(cur, prev, upGood)}</td>`;
}

function renderAnaTable(days) {
  const tbl = $('tblAna');
  const be = breakevenRoas();
  const head = ['Dia', 'Data', 'Gasto', 'Faturado', 'Lucro', 'ROAS', 'Compras', 'Custo/Compra', 'CPC', 'CTR', 'Hook', 'Freq.', 'Status', 'Obs'];
  tbl.innerHTML = '<thead><tr>' + head.map(h => `<th style="cursor:default">${h}</th>`).join('') + '</tr></thead><tbody>' +
    days.map((r, i) => {
      const p = i > 0 ? days[i - 1] : null;
      const roas = adRoasOf(r), roasP = p ? adRoasOf(p) : null;
      const cpa = cpaAdOf(r), cpaP = p ? cpaAdOf(p) : null;
      const luc = adLucroOf(r), lucP = p ? adLucroOf(p) : null;
      const roasCls = roas == null || be == null ? '' : (roas >= be ? 'good' : 'bad');
      const lucCls = luc == null ? '' : (luc >= 0 ? 'good' : 'bad');
      return `<tr>
        <td class="diaday">Dia ${i + 1}</td>
        <td>${fmtData(r.data)}</td>
        ${cellWithDelta(fmtBRL(r.gasto), r.gasto, p?.gasto, null)}
        ${cellWithDelta(fmtBRL(r.faturado), r.faturado, p?.faturado, true)}
        ${cellWithDelta(fmtBRL(luc), luc, lucP, true, lucCls)}
        ${cellWithDelta(fmtDec(roas), roas, roasP, true, roasCls)}
        ${cellWithDelta(fmtNum(r.compras), r.compras, p?.compras, true)}
        ${cellWithDelta(fmtBRL(cpa), cpa, cpaP, false)}
        ${cellWithDelta(fmtBRL(r.cpc), r.cpc, p?.cpc, false)}
        ${cellWithDelta(fmtPct(r.ctr), r.ctr, p?.ctr, true)}
        ${cellWithDelta(fmtPct(r.hook_rate), r.hook_rate, p?.hook_rate, true)}
        ${cellWithDelta(fmtDec(r.frequencia), r.frequencia, p?.frequencia, false)}
        <td><span class="badge ${r.status}">${r.status}</span></td>
        <td class="dim obscell">${esc(r.observacoes || '')}</td>
      </tr>`;
    }).join('') + '</tbody>';
}

function renderAnalise() {
  const names = adNames();
  const sel = $('anaAd');
  const cur = sel.value && names.includes(sel.value) ? sel.value : names[0];
  sel.innerHTML = names.map(n => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');

  const has = names.length > 0;
  $('anaEmpty').classList.toggle('hidden', has);
  $('anaBody').classList.toggle('hidden', !has);
  $('anaAd').classList.toggle('hidden', !has);
  if (!has) return;

  const days = adRows.filter(r => r.anuncio === cur).sort((a, b) => a.data.localeCompare(b.data));
  const d = diagnose(days);
  renderAnaKpis(d, days);
  renderAnaDiag(d);
  renderAnaCharts(days);
  renderAnaTable(days);
}

/* ---- comparação ---- */
function cmpValue(r, metric) {
  if (metric === 'roi') return adRoasOf(r);
  if (metric === 'cpa') return cpaAdOf(r);
  return r[metric] == null ? null : Number(r[metric]);
}
function renderCompare() {
  const list = filterByPeriod(adRows);
  const names = adNames();
  const colors = adColorMap();

  if (selectedAds === null) {
    const ags = aggregateAds().sort((a, b) => b.gasto - a.gasto);
    selectedAds = new Set(ags.slice(0, 4).map(a => a.anuncio));
  }
  for (const n of [...selectedAds]) if (!names.includes(n)) selectedAds.delete(n);

  $('cmpAds').innerHTML = names.map(n =>
    `<button class="chip${selectedAds.has(n) ? ' active' : ''}" data-ad="${esc(n)}"><span class="dot" style="background:${colors[n]}"></span>${esc(n)}</button>`
  ).join('') || '<span class="empty" style="padding:0">Lance anúncios para comparar.</span>';
  $('cmpAds').querySelectorAll('[data-ad]').forEach(b => b.addEventListener('click', () => {
    const n = b.dataset.ad;
    if (selectedAds.has(n)) selectedAds.delete(n); else selectedAds.add(n);
    renderCompare();
  }));

  const metric = $('cmpMetric').value;
  const dates = [...new Set(list.map(r => r.data))].sort();
  const datasets = names.filter(n => selectedAds.has(n)).map(n => {
    const byDate = new Map(list.filter(r => r.anuncio === n).map(r => [r.data, cmpValue(r, metric)]));
    return lineDataset(n, dates.map(d => byDate.has(d) ? byDate.get(d) : null), colors[n], false, false);
  });

  const isMoney = ['gasto', 'cpc', 'cpm', 'cpa', 'faturado'].includes(metric);
  const isPct = ['ctr', 'hook_rate', 'retencao_video'].includes(metric);
  const fmt = isMoney ? ((v, axis) => axis ? 'R$ ' + nf2.format(v) : fmtBRL(v)) : isPct ? ((v, axis) => axis ? nf0.format(v) + '%' : fmtPct(v)) : (v => fmtDec(v));
  const be = breakevenRoas();

  makeChart('chCompare', {
    type: 'line',
    data: { labels: dates.map(fmtDataCurta), datasets },
    options: baseOptions(fmt, {
      plugins: {
        legend: { display: datasets.length > 1, position: 'top', align: 'end', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, color: C.text2 } },
        refline: metric === 'roi' && be != null ? { y: be, label: `breakeven ${fmtDec(be)}` } : undefined,
      },
    }),
  });
}

/* ---- histórico ---- */
const COLS_HIST = [
  { key: 'data', label: 'Data', get: r => r.data, fmt: r => fmtData(r.data) },
  { key: 'anuncio', label: 'Anúncio', get: r => r.anuncio.toLowerCase(), fmt: r => esc(r.anuncio) },
  { key: 'status', label: 'Status', get: r => r.status, fmt: r => `<span class="badge ${r.status}">${r.status}</span>` },
  { key: 'gasto', label: 'Gasto', get: r => r.gasto, fmt: r => fmtBRL(r.gasto) },
  { key: 'faturado', label: 'Faturado', get: r => r.faturado, fmt: r => fmtBRL(r.faturado) },
  { key: 'lucro', label: 'Lucro', get: r => adLucroOf(r), fmt: r => fmtBRL(adLucroOf(r)), cls: r => { const v = adLucroOf(r); return v == null ? '' : (v >= 0 ? 'good' : 'bad'); } },
  { key: 'roas', label: 'ROAS', get: r => adRoasOf(r), fmt: r => adRoasOf(r) == null ? '—' : fmtDec(adRoasOf(r)), cls: r => { const v = adRoasOf(r), be = breakevenRoas(); return v == null || be == null ? '' : (v >= be ? 'good' : 'bad'); } },
  { key: 'compras', label: 'Compras', get: r => r.compras, fmt: r => fmtNum(r.compras) },
  { key: 'cpa', label: 'Custo/Compra', get: r => cpaAdOf(r), fmt: r => fmtBRL(cpaAdOf(r)) },
  { key: 'ctr', label: 'CTR', get: r => r.ctr, fmt: r => fmtPct(r.ctr) },
  { key: 'cpc', label: 'CPC', get: r => r.cpc, fmt: r => fmtBRL(r.cpc) },
  { key: 'cpm', label: 'CPM', get: r => r.cpm, fmt: r => fmtBRL(r.cpm) },
  { key: 'cliques', label: 'Cliques', get: r => r.cliques, fmt: r => fmtNum(r.cliques) },
  { key: 'hook_rate', label: 'Hook', get: r => r.hook_rate, fmt: r => fmtPct(r.hook_rate) },
  { key: 'retencao_video', label: 'Retenção', get: r => r.retencao_video, fmt: r => fmtPct(r.retencao_video) },
  { key: 'frequencia', label: 'Freq.', get: r => r.frequencia, fmt: r => fmtDec(r.frequencia) },
];

function renderAdsHist() {
  const tbl = $('tblAdsHist');
  let list = filterByPeriod(adRows);
  const filter = $('histAdFilter').value;
  if (filter) list = list.filter(r => r.anuncio === filter);
  $('emptyAdsHist').classList.toggle('hidden', list.length > 0);
  if (!list.length) { tbl.innerHTML = ''; return; }

  renderSortableTable(tbl, COLS_HIST, list, sortHist, {
    extraHead: ['Obs', ''],
    onSort: renderAdsHist,
    rowExtra: r => `<td class="dim obscell">${esc(r.observacoes || '')}</td>
      <td><div class="rowbtns">
        <button class="rowbtn" data-edit="${r.id}" title="Editar">✎</button>
        <button class="rowbtn del" data-del="${r.id}" title="Excluir">🗑</button>
      </div></td>`,
  });

  tbl.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => startEditAd(b.dataset.edit)));
  tbl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => delAd(b.dataset.del)));
}

/* ---- form Anúncios ---- */
function startEditAd(id) {
  const r = adRows.find(x => x.id === id);
  if (!r) return;
  editingAdId = id;
  $('a_data').value = r.data;
  $('a_anuncio').value = r.anuncio;
  $('a_status').value = r.status;
  $('a_gasto').value = numToInput(r.gasto);
  $('a_faturado').value = numToInput(r.faturado);
  $('a_compras').value = numToInput(r.compras);
  $('a_cpm').value = numToInput(r.cpm);
  $('a_cpc').value = numToInput(r.cpc);
  $('a_cliques').value = numToInput(r.cliques);
  $('a_ctr').value = numToInput(r.ctr);
  $('a_cpa').value = numToInput(r.custo_por_compra);
  $('a_roi').value = numToInput(r.roi);
  $('a_hook').value = numToInput(r.hook_rate);
  $('a_retencao').value = numToInput(r.retencao_video);
  $('a_frequencia').value = numToInput(r.frequencia);
  $('a_obs').value = r.observacoes || '';
  $('formCardAds').open = true;
  $('editTagAds').classList.remove('hidden');
  $('btnCancelAds').classList.remove('hidden');
  $('btnSalvarAds').textContent = 'Salvar alterações';
  updatePreviewsAds();
  $('formCardAds').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function resetFormAds() {
  editingAdId = null;
  $('formAds').reset();
  $('a_data').value = todayISO();
  $('editTagAds').classList.add('hidden');
  $('btnCancelAds').classList.add('hidden');
  $('btnSalvarAds').textContent = 'Salvar anúncio';
  updatePreviewsAds();
}
function collectAds() {
  return {
    data: $('a_data').value,
    anuncio: $('a_anuncio').value.trim(),
    status: $('a_status').value,
    campanha: projeto,
    gasto: parseNum($('a_gasto').value),
    cpm: parseNum($('a_cpm').value),
    cpc: parseNum($('a_cpc').value),
    cliques: parseInt0($('a_cliques').value),
    ctr: parseNum($('a_ctr').value),
    compras: parseInt0($('a_compras').value),
    custo_por_compra: parseNum($('a_cpa').value),
    faturado: parseNum($('a_faturado').value),
    roi: parseNum($('a_roi').value),
    hook_rate: parseNum($('a_hook').value),
    retencao_video: parseNum($('a_retencao').value),
    frequencia: parseNum($('a_frequencia').value),
    observacoes: $('a_obs').value.trim() || null,
  };
}
function updatePreviewsAds() {
  const gasto = parseNum($('a_gasto').value), fat = parseNum($('a_faturado').value), comp = parseNum($('a_compras').value);
  $('a_roi').placeholder = (gasto > 0 && fat != null) ? 'auto: ' + nf2.format(fat / gasto) : 'auto';
  $('a_cpa').placeholder = (comp > 0 && gasto != null) ? 'auto: ' + nf2.format(gasto / comp) : 'auto';
}

async function saveAd(e) {
  e.preventDefault();
  const rec = collectAds();
  if (!rec.data) return toast('Escolha a data.', true);
  if (!rec.anuncio) return toast('Dê um nome ao anúncio.', true);
  $('btnSalvarAds').disabled = true;
  try {
    if (editingAdId) {
      const { error } = await db.from('ads_anuncios_diarios').update(rec).eq('id', editingAdId);
      if (error) throw error;
      toast('Anúncio atualizado ✓');
    } else {
      const dup = adRows.find(r => r.data === rec.data && r.anuncio === rec.anuncio);
      if (dup && !confirm(`"${rec.anuncio}" já tem lançamento em ${fmtData(rec.data)}. Sobrescrever?`)) { $('btnSalvarAds').disabled = false; return; }
      const { error } = await db.from('ads_anuncios_diarios').upsert(rec, { onConflict: 'data,anuncio,campanha' });
      if (error) throw error;
      if (selectedAds) selectedAds.add(rec.anuncio);
      toast('Anúncio lançado ✓');
    }
    resetFormAds();
    await loadData();
  } catch (err) {
    toast('Erro ao salvar: ' + (err.message || err), true);
  }
  $('btnSalvarAds').disabled = false;
}
async function delAd(id) {
  const r = adRows.find(x => x.id === id);
  if (!r || !confirm(`Excluir "${r.anuncio}" de ${fmtData(r.data)}?`)) return;
  const { error } = await db.from('ads_anuncios_diarios').delete().eq('id', id);
  if (error) return toast('Erro ao excluir: ' + error.message, true);
  if (editingAdId === id) resetFormAds();
  toast('Lançamento excluído');
  await loadData();
}

/* =================================================================
   CSV
================================================================= */
function downloadCSV(filename, headers, lines) {
  const csv = '﻿' + [headers.join(';'), ...lines].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
const slug = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'projeto';
const csvNum = v => v == null ? '' : String(v).replace('.', ',');
const csvTxt = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;

function exportCsvGeral() {
  const list = filterByPeriod(rows);
  if (!list.length) return toast('Nada para exportar.', true);
  const headers = ['data', 'projeto', 'gasto', 'faturado_bruto', 'receita_liquida', 'lucro', 'margem_pct', 'roas', 'compras', 'custo_por_compra', 'vendas_iniciadas', 'checkouts_iniciados', 'taxa_conversao_checkout', 'cpm', 'cpc', 'cliques', 'visualizacao_pagina', 'perda_trafego', 'despesas_adicionais', 'reembolsos', 'chargeback', 'vendas_pendentes', 'compras_frontend', 'compras_backend', 'observacoes'];
  const lines = list.map(r => [
    r.data, csvTxt(r.campanha), csvNum(r.gasto), csvNum(r.faturado), csvNum(liquidoOf(r)), csvNum(lucroOf(r)), csvNum(margemOf(r)),
    csvNum(roasOf(r)), csvNum(r.compra), csvNum(cpaDiaOf(r)), csvNum(r.vendas_iniciadas), csvNum(r.finalizacao_compra), csvNum(taxaOf(r)),
    csvNum(r.cpm), csvNum(r.cpc), csvNum(r.cliques), csvNum(r.visualizacao_destino), csvNum(perdaOf(r)),
    csvNum(r.despesas_adicionais), csvNum(r.vendas_reembolsadas), csvNum(r.vendas_chargeback), csvNum(r.vendas_pendentes),
    csvNum(r.valor_compras_frontend), csvNum(r.valor_compras_backend), csvTxt(r.observacoes),
  ].join(';'));
  downloadCSV(`metricas_${slug(projeto)}_${todayISO()}.csv`, headers, lines);
}
function exportCsvAds() {
  const list = filterByPeriod(adRows);
  if (!list.length) return toast('Nada para exportar.', true);
  const headers = ['data', 'anuncio', 'projeto', 'status', 'gasto', 'faturado', 'lucro', 'roas', 'compras', 'custo_por_compra', 'cpm', 'cpc', 'cliques', 'ctr', 'hook_rate', 'retencao_video', 'frequencia', 'observacoes'];
  const lines = list.map(r => [
    r.data, csvTxt(r.anuncio), csvTxt(r.campanha), r.status, csvNum(r.gasto), csvNum(r.faturado), csvNum(adLucroOf(r)), csvNum(adRoasOf(r)),
    csvNum(r.compras), csvNum(cpaAdOf(r)), csvNum(r.cpm), csvNum(r.cpc), csvNum(r.cliques), csvNum(r.ctr),
    csvNum(r.hook_rate), csvNum(r.retencao_video), csvNum(r.frequencia), csvTxt(r.observacoes),
  ].join(';'));
  downloadCSV(`anuncios_${slug(projeto)}_${todayISO()}.csv`, headers, lines);
}

/* =================================================================
   PROJETOS
================================================================= */
async function loadProjetos() {
  const { data, error } = await db.from('ads_projetos').select('*').order('nome');
  if (error) { toast('Erro ao carregar projetos: ' + error.message, true); return; }
  projetos = data || [];
  if (!projetos.length) {
    const ins = await db.from('ads_projetos').insert({ nome: 'principal' }).select();
    projetos = ins.data || [{ nome: 'principal', taxa_pct: 0, imposto_pct: 0, custo_por_venda: 0, margem_alvo_pct: 20 }];
  }
  if (!projetos.some(p => p.nome === projeto)) setProjeto(projetos[0].nome, true);
  syncEco();
  renderProjSelect();
}
function syncEco() {
  const p = projetos.find(x => x.nome === projeto);
  eco = {
    taxa_pct: num(p?.taxa_pct), imposto_pct: num(p?.imposto_pct),
    custo_por_venda: num(p?.custo_por_venda), margem_alvo_pct: p?.margem_alvo_pct == null ? 20 : Number(p.margem_alvo_pct),
  };
}
function setProjeto(nome, silent) {
  projeto = nome;
  localStorage.setItem('ads_dash_projeto', nome);
  selectedAds = null;
  expandedDia = null;
  $('histAdFilter').value = '';
  syncEco();
  if (!silent) renderProjSelect();
}
function renderProjSelect() {
  $('projSel').innerHTML = projetos.map(p => `<option value="${esc(p.nome)}"${p.nome === projeto ? ' selected' : ''}>${esc(p.nome)}</option>`).join('');
  $('hintProjAds').textContent = projeto;
  $('btnDelProj').disabled = projetos.length < 2;
}
function renderProjCount() {
  const nAds = adNames().length;
  $('projCount').textContent = `${rows.length} ${rows.length === 1 ? 'dia' : 'dias'} · ${nAds} ${nAds === 1 ? 'anúncio' : 'anúncios'}`;
}

async function novoProjeto() {
  const nome = (prompt('Nome do novo projeto:') || '').trim();
  if (!nome) return;
  if (projetos.some(p => p.nome.toLowerCase() === nome.toLowerCase())) return toast('Já existe um projeto com esse nome.', true);
  const { error } = await db.from('ads_projetos').insert({ nome });
  if (error) return toast('Erro ao criar: ' + error.message, true);
  setProjeto(nome, true);
  await loadProjetos();
  await loadData();
  toast(`Projeto "${nome}" criado ✓`);
}

async function renomearProjeto() {
  const nome = (prompt('Novo nome do projeto:', projeto) || '').trim();
  if (!nome || nome === projeto) return;
  if (projetos.some(p => p.nome.toLowerCase() === nome.toLowerCase())) return toast('Já existe um projeto com esse nome.', true);
  const antigo = projeto;
  let { error } = await db.from('ads_projetos').update({ nome }).eq('nome', antigo);
  if (error) return toast('Erro ao renomear: ' + error.message, true);
  for (const t of ['ads_metricas_diarias', 'ads_anuncios_diarios']) {
    const r = await db.from(t).update({ campanha: nome }).eq('campanha', antigo);
    if (r.error) return toast('Erro ao mover lançamentos: ' + r.error.message, true);
  }
  setProjeto(nome, true);
  await loadProjetos();
  await loadData();
  toast(`Renomeado para "${nome}" ✓`);
}

async function excluirProjeto() {
  if (projetos.length < 2) return toast('Você precisa ter pelo menos um projeto.', true);
  const nAds = adNames().length;
  if (!confirm(`Excluir o projeto "${projeto}"?\n\nIsso apaga ${rows.length} dia(s) e ${nAds} anúncio(s) — não dá pra desfazer.`)) return;
  if ((prompt('Para confirmar, digite o nome do projeto:') || '').trim() !== projeto) return toast('Nome não confere — nada foi excluído.');
  for (const t of ['ads_metricas_diarias', 'ads_anuncios_diarios']) {
    const r = await db.from(t).delete().eq('campanha', projeto);
    if (r.error) return toast('Erro ao excluir: ' + r.error.message, true);
  }
  const { error } = await db.from('ads_projetos').delete().eq('nome', projeto);
  if (error) return toast('Erro ao excluir: ' + error.message, true);
  const nome = projeto;
  resetFormGeral(); resetFormAds();
  setProjeto(projetos.find(p => p.nome !== projeto).nome, true);
  await loadProjetos();
  await loadData();
  toast(`Projeto "${nome}" excluído`);
}

async function excluirAnuncio(nome) {
  const dias = adRows.filter(r => r.anuncio === nome).length;
  if (!confirm(`Excluir o anúncio "${nome}" e todos os ${dias} dia(s) lançados dele?`)) return;
  const { error } = await db.from('ads_anuncios_diarios').delete().eq('campanha', projeto).eq('anuncio', nome);
  if (error) return toast('Erro ao excluir: ' + error.message, true);
  if (editingAdId && adRows.some(r => r.id === editingAdId && r.anuncio === nome)) resetFormAds();
  if (selectedAds) selectedAds.delete(nome);
  toast(`Anúncio "${nome}" excluído`);
  await loadData();
}

/* =================================================================
   Dados / render
================================================================= */
async function loadData() {
  const [g, a] = await Promise.all([
    db.from('ads_metricas_diarias').select('*').eq('campanha', projeto).order('data', { ascending: true }),
    db.from('ads_anuncios_diarios').select('*').eq('campanha', projeto).order('data', { ascending: true }),
  ]);
  if (g.error) { toast('Erro ao carregar: ' + g.error.message, true); return; }
  if (a.error) { toast('Erro ao carregar: ' + a.error.message, true); return; }
  rows = (g.data || []).map(coerceGeral);
  adRows = (a.data || []).map(coerceAd);
  if (expandedDia && !rows.some(r => r.data === expandedDia)) expandedDia = null;
  renderAll();
}
function coerceGeral(r) {
  for (const k of ['gasto', 'faturado', 'valor_compras_frontend', 'valor_compras_backend', 'cpm', 'cpc', 'perda_trafego', 'taxa_conversao_checkout', 'roi', 'faturamento_liquido', 'despesas_adicionais', 'vendas_reembolsadas', 'vendas_chargeback', 'vendas_pendentes'])
    if (r[k] != null) r[k] = Number(r[k]);
  return r;
}
function coerceAd(r) {
  for (const k of ['gasto', 'cpm', 'cpc', 'ctr', 'custo_por_compra', 'faturado', 'roi', 'hook_rate', 'retencao_video', 'frequencia'])
    if (r[k] != null) r[k] = Number(r[k]);
  return r;
}
function renderAll() {
  renderProjCount();
  renderKpis();
  renderVeredito();
  renderCharts();
  renderFunil();
  renderTableGeral();
  renderAdDatalist();
  renderRanking();
  renderAnalise();
  renderCompare();
  renderAdsHist();
  updatePreviewsGeral();
}

/* =================================================================
   Auth + boot
================================================================= */
function trocarAba(nome) {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === nome));
  $('tab-geral').classList.toggle('hidden', nome !== 'geral');
  $('tab-anuncios').classList.toggle('hidden', nome !== 'anuncios');
}
function showLogin() {
  $('splash').classList.add('hidden');
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}
async function enterApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  await loadProjetos();
  await loadData();
  $('splash').classList.add('hidden');
}

function periodLabel() {
  if (period === -1) {
    if (range.de && range.ate) return `${fmtData(range.de)} → ${fmtData(range.ate)}`;
    if (range.de) return `a partir de ${fmtData(range.de)}`;
    if (range.ate) return `até ${fmtData(range.ate)}`;
    return 'todo o período';
  }
  if (period === 1) return 'hoje';
  return period ? `últimos ${period} dias` : 'todo o período';
}
function syncPeriodChips() {
  document.querySelectorAll('#periodChips .chip, #periodChipsAds .chip').forEach(c =>
    c.classList.toggle('active', parseInt(c.dataset.days, 10) === period));
  document.querySelectorAll('.rangebar').forEach(bar => {
    bar.classList.toggle('hidden', period !== -1);
    bar.querySelector('.r_de').value = range.de;
    bar.querySelector('.r_ate').value = range.ate;
    bar.querySelector('.rangeinfo').textContent = period === -1 ? periodLabel() : '';
  });
}
function aplicarRange(bar) {
  const de = bar.querySelector('.r_de').value;
  const ate = bar.querySelector('.r_ate').value;
  if (de && ate && de > ate) return toast('A data inicial é depois da final.', true);
  range = { de, ate };
  localStorage.setItem('ads_dash_range', JSON.stringify(range));
  syncPeriodChips();
  renderAll();
}

function ecoPreviewText() {
  const taxa = parseNum($('s_taxa').value) || 0;
  const imp = parseNum($('s_imposto').value) || 0;
  const marg = parseNum($('s_margem').value) || 0;
  const d = taxa + imp;
  if (d >= 100) return $('ecoPreview').textContent = 'Taxa + imposto não podem chegar a 100%.';
  const be = 1 / (1 - d / 100);
  $('ecoPreview').innerHTML = `Ponto de equilíbrio: <b>ROAS ${fmtDec(be)}</b> · alvo para ${nf0.format(marg)}% de margem: <b>ROAS ${fmtDec(be * (1 + marg / 100))}</b>`;
}

async function boot() {
  const savedPeriod = parseInt(localStorage.getItem('ads_dash_period') || '0', 10);
  if ([-1, 0, 1, 7, 30].includes(savedPeriod)) period = savedPeriod;
  syncPeriodChips();

  $('f_data').value = todayISO();
  $('a_data').value = todayISO();
  if (window.innerWidth > 860) { $('formCardGeral').open = true; }

  $('formGeral').addEventListener('submit', saveGeral);
  $('formAds').addEventListener('submit', saveAd);
  $('btnCancelGeral').addEventListener('click', resetFormGeral);
  $('btnCancelAds').addEventListener('click', resetFormAds);
  $('btnSomarAds').addEventListener('click', somarDosAnuncios);
  for (const id of ['f_gasto', 'f_faturado', 'f_compra', 'f_cliques', 'f_visualizacao', 'f_finalizacao', 'f_liquido', 'f_despesas', 'f_reembolso', 'f_chargeback'])
    $(id).addEventListener('input', updatePreviewsGeral);
  for (const id of ['a_gasto', 'a_faturado', 'a_compras']) $(id).addEventListener('input', updatePreviewsAds);

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => trocarAba(t.dataset.tab)));

  document.querySelectorAll('#periodChips .chip, #periodChipsAds .chip').forEach(c => c.addEventListener('click', () => {
    period = parseInt(c.dataset.days, 10);
    localStorage.setItem('ads_dash_period', String(period));
    if (period === -1 && !range.de && !range.ate) {
      const d = new Date(); d.setDate(d.getDate() - 6);
      range = { de: isoOf(d), ate: todayISO() };
      localStorage.setItem('ads_dash_range', JSON.stringify(range));
    }
    syncPeriodChips();
    renderAll();
  }));
  document.querySelectorAll('.rangebar').forEach(bar => {
    bar.querySelector('.r_apply').addEventListener('click', () => aplicarRange(bar));
    bar.querySelectorAll('input[type="date"]').forEach(i => i.addEventListener('change', () => aplicarRange(bar)));
  });

  $('projSel').addEventListener('change', async () => {
    setProjeto($('projSel').value);
    resetFormGeral(); resetFormAds();
    await loadData();
  });
  $('btnNewProj').addEventListener('click', novoProjeto);
  $('btnRenameProj').addEventListener('click', renomearProjeto);
  $('btnDelProj').addEventListener('click', excluirProjeto);

  $('btnCsvGeral').addEventListener('click', exportCsvGeral);
  $('btnCsvAds').addEventListener('click', exportCsvAds);

  $('anaAd').addEventListener('change', renderAnalise);
  $('cmpMetric').addEventListener('change', renderCompare);
  $('histAdFilter').addEventListener('change', renderAdsHist);

  /* settings */
  $('btnSettings').addEventListener('click', () => {
    $('ecoProjName').textContent = '· ' + projeto;
    $('s_taxa').value = numToInput(eco.taxa_pct);
    $('s_imposto').value = numToInput(eco.imposto_pct);
    $('s_custo').value = numToInput(eco.custo_por_venda);
    $('s_margem').value = numToInput(eco.margem_alvo_pct);
    $('s_perda').value = numToInput(settings.perdaMax);
    $('s_spike').value = numToInput(settings.spikePct);
    ecoPreviewText();
    $('settingsModal').classList.remove('hidden');
  });
  for (const id of ['s_taxa', 's_imposto', 's_margem']) $(id).addEventListener('input', ecoPreviewText);
  $('btnCloseSettings').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
  $('settingsModal').addEventListener('click', e => { if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden'); });
  $('btnSaveSettings').addEventListener('click', async () => {
    const novo = {
      taxa_pct: parseNum($('s_taxa').value) ?? 0,
      imposto_pct: parseNum($('s_imposto').value) ?? 0,
      custo_por_venda: parseNum($('s_custo').value) ?? 0,
      margem_alvo_pct: parseNum($('s_margem').value) ?? 20,
    };
    if (novo.taxa_pct + novo.imposto_pct >= 100) return toast('Taxa + imposto não podem chegar a 100%.', true);
    const { error } = await db.from('ads_projetos').update(novo).eq('nome', projeto);
    if (error) return toast('Erro ao salvar economia: ' + error.message, true);

    settings.perdaMax = parseNum($('s_perda').value) ?? DEFAULT_SETTINGS.perdaMax;
    settings.spikePct = parseNum($('s_spike').value) ?? DEFAULT_SETTINGS.spikePct;
    localStorage.setItem('ads_dash_settings', JSON.stringify(settings));

    await loadProjetos();
    $('settingsModal').classList.add('hidden');
    toast('Configurações salvas ✓');
    renderAll();
  });

  /* auth */
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('loginBtn').disabled = true;
    $('loginErr').classList.add('hidden');
    const { error } = await db.auth.signInWithPassword({ email: $('loginEmail').value, password: $('loginPass').value });
    $('loginBtn').disabled = false;
    if (error) {
      $('loginErr').textContent = error.message.includes('Invalid login') ? 'Senha incorreta.' : 'Erro: ' + error.message;
      $('loginErr').classList.remove('hidden');
      return;
    }
    await enterApp();
  });
  $('btnLogout').addEventListener('click', async () => {
    if (!confirm('Sair do dashboard?')) return;
    await db.auth.signOut();
    location.reload();
  });

  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (expandedDia) { ajustarDiabox(); drawDiaChart(expandedDia); } }, 150);
  });

  const { data: { session } } = await db.auth.getSession();
  if (session) await enterApp();
  else showLogin();
}

boot();
