/* ===== Métricas — Tráfego Pago · app ===== */
'use strict';

/* ---------- Supabase ---------- */
const SUPABASE_URL = 'https://nyuycffqncuavzuhyofq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_soW7Jl52hpZYkaJtmDT6tg_4111FV8W';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- Estado ---------- */
let rows = [];      // ads_metricas_diarias (asc por data)
let adRows = [];    // ads_anuncios_diarios (asc por data)
let period = 0;     // 0 = tudo, 7, 30
let editingId = null;
let editingAdId = null;
let selectedAds = null;          // Set de anúncios no gráfico de comparação
let sortGeral = { key: 'data', dir: -1 };
let sortRank = { key: 'gasto', dir: -1 };
let sortHist = { key: 'data', dir: -1 };
const charts = {};

const DEFAULT_SETTINGS = { roiMin: 1, perdaMax: 20, spikePct: 30 };
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('ads_dash_settings') || '{}') }; } catch (e) { /* usa default */ }

/* ---------- Paleta (validada — dataviz) ---------- */
const SERIES = ['#3987e5', '#199e70', '#c98500', '#9085e9', '#e66767', '#d55181', '#d95926', '#008300'];
const C = {
  text: '#f2f2f5', text2: '#a0a0ab', muted: '#8b8b96', grid: '#26262c',
  card: '#14141b', card2: '#1c1c24', good: '#34c759', bad: '#e66767',
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

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtData(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y.slice(2)}`; }
function fmtDataCurta(iso) { const [, m, d] = iso.split('-'); return `${d}/${m}`; }

/* ---------- Métricas calculadas ---------- */
function roiOf(r) { return r.roi != null ? Number(r.roi) : (r.gasto > 0 && r.faturado != null ? r.faturado / r.gasto : null); }
function taxaOf(r) { return r.taxa_conversao_checkout != null ? Number(r.taxa_conversao_checkout) : (r.finalizacao_compra > 0 && r.compra != null ? (r.compra / r.finalizacao_compra) * 100 : null); }
function cpaOf(r) { return r.custo_por_compra != null ? Number(r.custo_por_compra) : (r.compras > 0 && r.gasto != null ? r.gasto / r.compras : null); }
function adRoiOf(r) { return r.roi != null ? Number(r.roi) : (r.gasto > 0 && r.faturado != null ? r.faturado / r.gasto : null); }

/* média dos até 7 registros anteriores (para alerta de pico de CPC/CPM) */
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
  const avg = avgPrev(list, idx, field);
  if (avg == null) return '';
  return Number(v) > avg * (1 + settings.spikePct / 100) ? 'warn' : '';
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
  if (!period) return list;
  const cut = new Date();
  cut.setDate(cut.getDate() - (period - 1));
  const cutISO = `${cut.getFullYear()}-${String(cut.getMonth() + 1).padStart(2, '0')}-${String(cut.getDate()).padStart(2, '0')}`;
  return list.filter(r => r.data >= cutISO);
}

/* ---------- Chart.js base ---------- */
Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
Chart.defaults.font.size = 11.5;
Chart.defaults.color = C.muted;
Chart.defaults.borderColor = C.grid;

const reflinePlugin = {
  id: 'refline',
  afterDatasetsDraw(chart) {
    const opt = chart.options.plugins?.refline;
    if (!opt || opt.y == null) return;
    const { ctx, chartArea, scales } = chart;
    const y = scales.y.getPixelForValue(opt.y);
    if (y < chartArea.top || y > chartArea.bottom) return;
    ctx.save();
    ctx.strokeStyle = opt.color || '#55555f';
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.restore();
  },
};
Chart.register(reflinePlugin);

function baseOptions(fmt, extra) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: C.card2, borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1,
        titleColor: C.text, bodyColor: C.text2, padding: 10, cornerRadius: 8,
        boxWidth: 8, boxHeight: 8, boxPadding: 4, usePointStyle: true,
        callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` },
      },
      ...(extra?.plugins || {}),
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
      y: {
        beginAtZero: true,
        grid: { color: C.grid, lineWidth: 1 },
        border: { display: false },
        ticks: { callback: v => fmt(v, true), maxTicksLimit: 6 },
        ...(extra?.y || {}),
      },
    },
  };
}
function lineDataset(label, data, color, fillArea) {
  return {
    label, data, borderColor: color, backgroundColor: fillArea ? color + '1a' : color,
    borderWidth: 2, tension: 0.25, fill: !!fillArea, spanGaps: true,
    pointRadius: 3, pointBackgroundColor: color, pointBorderColor: C.card, pointBorderWidth: 2,
    pointHoverRadius: 6, pointHoverBorderWidth: 2,
  };
}
function makeChart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), cfg);
}

/* =================================================================
   VISÃO GERAL
================================================================= */
function renderKpis() {
  const grid = $('kpiGrid');
  const sorted = [...rows].sort((a, b) => a.data.localeCompare(b.data));
  const last = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  if (!last) { grid.innerHTML = ''; return; }

  const defs = [
    { label: 'Gasto', value: fmtBRL(last.gasto), raw: last.gasto, prevRaw: prev?.gasto, upGood: null },
    { label: 'Faturado', value: fmtBRL(last.faturado), raw: last.faturado, prevRaw: prev?.faturado, upGood: true },
    { label: 'ROI', value: roiOf(last) == null ? '—' : fmtDec(roiOf(last)), raw: roiOf(last), prevRaw: prev ? roiOf(prev) : null, upGood: true, colorByRoi: true },
    { label: 'Taxa Conv. Checkout', value: fmtPct(taxaOf(last)), raw: taxaOf(last), prevRaw: prev ? taxaOf(prev) : null, upGood: true },
  ];

  grid.innerHTML = defs.map(d => {
    let deltaHtml = `<div class="kdelta">vs dia anterior: —</div>`;
    if (d.raw != null && d.prevRaw != null && d.prevRaw !== 0) {
      const pct = ((d.raw - d.prevRaw) / Math.abs(d.prevRaw)) * 100;
      const up = pct >= 0;
      let cls = '';
      if (d.upGood === true) cls = up ? 'up' : 'down';
      else if (d.upGood === false) cls = up ? 'down' : 'up';
      const arrow = up ? '▲' : '▼';
      deltaHtml = `<div class="kdelta ${cls}">${arrow} ${nf2.format(Math.abs(pct))}% vs dia anterior</div>`;
    }
    let vCls = '';
    let alert = '';
    if (d.colorByRoi && d.raw != null) {
      vCls = d.raw >= settings.roiMin ? 'good' : 'bad';
      if (d.raw < settings.roiMin) alert = ' alert';
    }
    return `<div class="kpi${alert}">
      <div class="klabel">${d.label} <span style="font-weight:500">· ${fmtDataCurta(last.data)}</span></div>
      <div class="kvalue ${vCls}">${d.value}</div>
      ${deltaHtml}
    </div>`;
  }).join('');
}

function renderCharts() {
  const list = filterByPeriod(rows);
  const labels = list.map(r => fmtDataCurta(r.data));
  const money = (v, axis) => axis ? 'R$ ' + nf0.format(v) : fmtBRL(v);
  const dec = v => fmtDec(v);
  const pct = (v, axis) => axis ? nf0.format(v) + '%' : fmtPct(v);

  makeChart('chGastoFat', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Gasto', data: list.map(r => r.gasto), backgroundColor: SERIES[0], borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24, categoryPercentage: 0.65, barPercentage: 0.9 },
        { label: 'Faturado', data: list.map(r => r.faturado), backgroundColor: SERIES[1], borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24, categoryPercentage: 0.65, barPercentage: 0.9 },
      ],
    },
    options: baseOptions(money, {
      plugins: { legend: { display: true, position: 'top', align: 'end', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, color: C.text2 } } },
    }),
  });

  makeChart('chRoi', {
    type: 'line',
    data: { labels, datasets: [lineDataset('ROI', list.map(r => roiOf(r)), SERIES[0], true)] },
    options: baseOptions(dec, { plugins: { refline: { y: settings.roiMin } }, y: { suggestedMax: 1.2 } }),
  });

  makeChart('chCpc', {
    type: 'line',
    data: { labels, datasets: [lineDataset('CPC', list.map(r => r.cpc), SERIES[0], true)] },
    options: baseOptions(v => typeof v === 'number' ? 'R$ ' + nf2.format(v) : v),
  });

  makeChart('chCpm', {
    type: 'line',
    data: { labels, datasets: [lineDataset('CPM', list.map(r => r.cpm), SERIES[0], true)] },
    options: baseOptions(v => typeof v === 'number' ? 'R$ ' + nf2.format(v) : v),
  });

  makeChart('chTaxa', {
    type: 'line',
    data: { labels, datasets: [lineDataset('Taxa de conversão', list.map(r => taxaOf(r)), SERIES[0], true)] },
    options: baseOptions(pct),
  });
}

const COLS_GERAL = [
  { key: 'data', label: 'Data', get: r => r.data, fmt: r => fmtData(r.data) },
  { key: 'gasto', label: 'Gasto', get: r => r.gasto, fmt: r => fmtBRL(r.gasto) },
  { key: 'faturado', label: 'Faturado', get: r => r.faturado, fmt: r => fmtBRL(r.faturado) },
  { key: 'roi', label: 'ROI', get: r => roiOf(r), fmt: r => roiOf(r) == null ? '—' : fmtDec(roiOf(r)), cls: r => { const v = roiOf(r); return v == null ? '' : (v >= settings.roiMin ? 'good' : 'bad'); } },
  { key: 'taxa', label: 'Taxa Conv.', get: r => taxaOf(r), fmt: r => fmtPct(taxaOf(r)) },
  { key: 'compra', label: 'Compras', get: r => r.compra, fmt: r => fmtNum(r.compra) },
  { key: 'finalizacao_compra', label: 'Fin. Compra', get: r => r.finalizacao_compra, fmt: r => fmtNum(r.finalizacao_compra) },
  { key: 'cpc', label: 'CPC', get: r => r.cpc, fmt: r => fmtBRL(r.cpc), spike: 'cpc' },
  { key: 'cpm', label: 'CPM', get: r => r.cpm, fmt: r => fmtBRL(r.cpm), spike: 'cpm' },
  { key: 'cliques', label: 'Cliques', get: r => r.cliques, fmt: r => fmtNum(r.cliques) },
  { key: 'visualizacao_destino', label: 'Vis. Destino', get: r => r.visualizacao_destino, fmt: r => fmtNum(r.visualizacao_destino) },
  { key: 'perda_trafego', label: 'Perda Tráf.', get: r => r.perda_trafego, fmt: r => fmtPct(r.perda_trafego), cls: r => r.perda_trafego != null && Number(r.perda_trafego) > settings.perdaMax ? 'bad' : '' },
  { key: 'valor_compras_frontend', label: 'Front-End', get: r => r.valor_compras_frontend, fmt: r => fmtBRL(r.valor_compras_frontend) },
  { key: 'valor_compras_backend', label: 'Back-End', get: r => r.valor_compras_backend, fmt: r => fmtBRL(r.valor_compras_backend) },
];

function renderTableGeral() {
  const tbl = $('tblGeral');
  const list = filterByPeriod(rows);
  $('emptyGeral').classList.toggle('hidden', list.length > 0);
  if (!list.length) { tbl.innerHTML = ''; return; }

  const asc = [...rows].sort((a, b) => a.data.localeCompare(b.data)); // p/ cálculo de pico
  const idxByid = new Map(asc.map((r, i) => [r.id, i]));

  const col = COLS_GERAL.find(c => c.key === sortGeral.key) || COLS_GERAL[0];
  const sorted = [...list].sort((a, b) => {
    const va = col.get(a), vb = col.get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * sortGeral.dir;
  });

  const head = '<thead><tr>' + COLS_GERAL.map(c =>
    `<th data-key="${c.key}">${c.label}${sortGeral.key === c.key ? ` <span class="arrow">${sortGeral.dir === 1 ? '▲' : '▼'}</span>` : ''}</th>`
  ).join('') + '<th>Obs</th><th></th></tr></thead>';

  const body = '<tbody>' + sorted.map(r => {
    const i = idxByid.get(r.id);
    const tds = COLS_GERAL.map(c => {
      let cls = c.cls ? c.cls(r) : '';
      if (!cls && c.spike) cls = spikeClass(asc, i, c.spike);
      const v = c.fmt(r);
      return `<td class="${v === '—' ? 'dim' : cls}">${v}</td>`;
    }).join('');
    return `<tr>${tds}<td class="dim" style="max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc(r.observacoes || '')}</td>
      <td><div class="rowbtns">
        <button class="rowbtn" data-edit="${r.id}" title="Editar">✎</button>
        <button class="rowbtn del" data-del="${r.id}" title="Excluir">🗑</button>
      </div></td></tr>`;
  }).join('') + '</tbody>';

  tbl.innerHTML = head + body;

  tbl.querySelectorAll('th[data-key]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.key;
    if (sortGeral.key === k) sortGeral.dir *= -1; else sortGeral = { key: k, dir: -1 };
    renderTableGeral();
  }));
  tbl.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => startEditGeral(b.dataset.edit)));
  tbl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => delGeral(b.dataset.del)));
}

/* ---- form Visão Geral ---- */
function startEditGeral(id) {
  const r = rows.find(x => x.id === id);
  if (!r) return;
  editingId = id;
  $('f_data').value = r.data;
  $('f_campanha').value = r.campanha || 'principal';
  $('f_gasto').value = numToInput(r.gasto);
  $('f_faturado').value = numToInput(r.faturado);
  $('f_frontend').value = numToInput(r.valor_compras_frontend);
  $('f_backend').value = numToInput(r.valor_compras_backend);
  $('f_cpm').value = numToInput(r.cpm);
  $('f_cliques').value = numToInput(r.cliques);
  $('f_cpc').value = numToInput(r.cpc);
  $('f_visualizacao').value = numToInput(r.visualizacao_destino);
  $('f_perda').value = numToInput(r.perda_trafego);
  $('f_finalizacao').value = numToInput(r.finalizacao_compra);
  $('f_compra').value = numToInput(r.compra);
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
  $('f_campanha').value = 'principal';
  $('editTagGeral').classList.add('hidden');
  $('btnCancelGeral').classList.add('hidden');
  $('btnSalvarGeral').textContent = 'Salvar dia';
  updatePreviewsGeral();
}
function collectGeral() {
  return {
    data: $('f_data').value,
    campanha: $('f_campanha').value.trim() || 'principal',
    gasto: parseNum($('f_gasto').value),
    faturado: parseNum($('f_faturado').value),
    valor_compras_frontend: parseNum($('f_frontend').value),
    valor_compras_backend: parseNum($('f_backend').value),
    cpm: parseNum($('f_cpm').value),
    cliques: parseInt0($('f_cliques').value),
    cpc: parseNum($('f_cpc').value),
    visualizacao_destino: parseInt0($('f_visualizacao').value),
    perda_trafego: parseNum($('f_perda').value),
    finalizacao_compra: parseInt0($('f_finalizacao').value),
    compra: parseInt0($('f_compra').value),
    taxa_conversao_checkout: parseNum($('f_taxa').value),
    roi: parseNum($('f_roi').value),
    observacoes: $('f_obs').value.trim() || null,
  };
}
function updatePreviewsGeral() {
  const gasto = parseNum($('f_gasto').value), fat = parseNum($('f_faturado').value);
  $('f_roi').placeholder = (gasto > 0 && fat != null) ? 'auto: ' + nf2.format(fat / gasto) : 'auto';
  const fin = parseNum($('f_finalizacao').value), comp = parseNum($('f_compra').value);
  $('f_taxa').placeholder = (fin > 0 && comp != null) ? 'auto: ' + nf2.format((comp / fin) * 100) + '%' : 'auto';
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
      const dup = rows.find(r => r.data === rec.data && r.campanha === rec.campanha);
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
function adNames() {
  return [...new Set(adRows.map(r => r.anuncio))];
}

function renderAdDatalist() {
  $('adNames').innerHTML = adNames().map(n => `<option value="${esc(n)}">`).join('');
  const sel = $('histAdFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todos os anúncios</option>' + adNames().map(n => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

const COLS_RANK = [
  { key: 'anuncio', label: 'Anúncio', get: a => a.anuncio.toLowerCase(), fmt: a => `<span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${a.color};margin-right:7px"></span>${esc(a.anuncio)}` },
  { key: 'status', label: 'Status', get: a => a.status, fmt: a => `<span class="badge ${a.status}">${a.status}</span>` },
  { key: 'gasto', label: 'Gasto', get: a => a.gasto, fmt: a => fmtBRL(a.gasto) },
  { key: 'faturado', label: 'Faturado', get: a => a.faturado, fmt: a => fmtBRL(a.faturado) },
  { key: 'roi', label: 'ROI', get: a => a.roi, fmt: a => a.roi == null ? '—' : fmtDec(a.roi), cls: a => a.roi == null ? '' : (a.roi >= settings.roiMin ? 'good' : 'bad') },
  { key: 'compras', label: 'Compras', get: a => a.compras, fmt: a => fmtNum(a.compras) },
  { key: 'cpa', label: 'Custo/Compra', get: a => a.cpa, fmt: a => fmtBRL(a.cpa) },
  { key: 'ctr', label: 'CTR méd.', get: a => a.ctr, fmt: a => fmtPct(a.ctr) },
  { key: 'cpc', label: 'CPC méd.', get: a => a.cpc, fmt: a => fmtBRL(a.cpc) },
  { key: 'hook', label: 'Hook méd.', get: a => a.hook, fmt: a => fmtPct(a.hook) },
  { key: 'dias', label: 'Dias', get: a => a.dias, fmt: a => fmtNum(a.dias) },
];

function aggregateAds() {
  const list = filterByPeriod(adRows);
  const colors = adColorMap();
  const byAd = {};
  for (const r of list) {
    const a = byAd[r.anuncio] || (byAd[r.anuncio] = { anuncio: r.anuncio, color: colors[r.anuncio], gasto: 0, faturado: 0, compras: 0, ctrs: [], cpcs: [], hooks: [], dias: 0, lastData: '', status: 'ativo' });
    a.dias++;
    if (r.gasto != null) a.gasto += Number(r.gasto);
    if (r.faturado != null) a.faturado += Number(r.faturado);
    if (r.compras != null) a.compras += Number(r.compras);
    if (r.ctr != null) a.ctrs.push(Number(r.ctr));
    if (r.cpc != null) a.cpcs.push(Number(r.cpc));
    if (r.hook_rate != null) a.hooks.push(Number(r.hook_rate));
    if (r.data >= a.lastData) { a.lastData = r.data; a.status = r.status; }
  }
  return Object.values(byAd).map(a => ({
    ...a,
    roi: a.gasto > 0 ? a.faturado / a.gasto : null,
    cpa: a.compras > 0 ? a.gasto / a.compras : null,
    ctr: a.ctrs.length ? a.ctrs.reduce((x, y) => x + y, 0) / a.ctrs.length : null,
    cpc: a.cpcs.length ? a.cpcs.reduce((x, y) => x + y, 0) / a.cpcs.length : null,
    hook: a.hooks.length ? a.hooks.reduce((x, y) => x + y, 0) / a.hooks.length : null,
  }));
}

function renderRanking() {
  const tbl = $('tblRanking');
  const ags = aggregateAds();
  $('rankPeriodo').textContent = period === 1 ? '· hoje' : period ? `· últimos ${period} dias` : '· todo o período';
  $('emptyRanking').classList.toggle('hidden', ags.length > 0);
  if (!ags.length) { tbl.innerHTML = ''; return; }

  const col = COLS_RANK.find(c => c.key === sortRank.key) || COLS_RANK[2];
  ags.sort((a, b) => {
    const va = col.get(a), vb = col.get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * sortRank.dir;
  });

  tbl.innerHTML = '<thead><tr>' + COLS_RANK.map(c =>
    `<th data-key="${c.key}">${c.label}${sortRank.key === c.key ? ` <span class="arrow">${sortRank.dir === 1 ? '▲' : '▼'}</span>` : ''}</th>`
  ).join('') + '</tr></thead><tbody>' +
    ags.map(a => '<tr>' + COLS_RANK.map(c => {
      const v = c.fmt(a);
      const cls = c.cls ? c.cls(a) : '';
      return `<td class="${v === '—' ? 'dim' : cls}">${v}</td>`;
    }).join('') + '</tr>').join('') + '</tbody>';

  tbl.querySelectorAll('th[data-key]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.key;
    if (sortRank.key === k) sortRank.dir *= -1; else sortRank = { key: k, dir: -1 };
    renderRanking();
  }));
}

/* ---- comparação ---- */
function cmpValue(r, metric) {
  if (metric === 'roi') return adRoiOf(r);
  if (metric === 'cpa') return cpaOf(r);
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
    return lineDataset(n, dates.map(d => byDate.has(d) ? byDate.get(d) : null), colors[n]);
  });

  const isMoney = ['gasto', 'cpc', 'cpm', 'cpa', 'faturado'].includes(metric);
  const isPct = ['ctr', 'hook_rate', 'retencao_video'].includes(metric);
  const fmt = isMoney ? ((v, axis) => axis ? 'R$ ' + nf2.format(v) : fmtBRL(v)) : isPct ? ((v, axis) => axis ? nf0.format(v) + '%' : fmtPct(v)) : (v => fmtDec(v));

  makeChart('chCompare', {
    type: 'line',
    data: { labels: dates.map(fmtDataCurta), datasets },
    options: baseOptions(fmt, {
      plugins: {
        legend: { display: datasets.length > 1, position: 'top', align: 'end', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, color: C.text2 } },
        refline: metric === 'roi' ? { y: settings.roiMin } : undefined,
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
  { key: 'roi', label: 'ROI', get: r => adRoiOf(r), fmt: r => adRoiOf(r) == null ? '—' : fmtDec(adRoiOf(r)), cls: r => { const v = adRoiOf(r); return v == null ? '' : (v >= settings.roiMin ? 'good' : 'bad'); } },
  { key: 'compras', label: 'Compras', get: r => r.compras, fmt: r => fmtNum(r.compras) },
  { key: 'cpa', label: 'Custo/Compra', get: r => cpaOf(r), fmt: r => fmtBRL(cpaOf(r)) },
  { key: 'faturado', label: 'Faturado', get: r => r.faturado, fmt: r => fmtBRL(r.faturado) },
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

  const col = COLS_HIST.find(c => c.key === sortHist.key) || COLS_HIST[0];
  const sorted = [...list].sort((a, b) => {
    const va = col.get(a), vb = col.get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * sortHist.dir;
  });

  tbl.innerHTML = '<thead><tr>' + COLS_HIST.map(c =>
    `<th data-key="${c.key}">${c.label}${sortHist.key === c.key ? ` <span class="arrow">${sortHist.dir === 1 ? '▲' : '▼'}</span>` : ''}</th>`
  ).join('') + '<th>Obs</th><th></th></tr></thead><tbody>' +
    sorted.map(r => '<tr>' + COLS_HIST.map(c => {
      const v = c.fmt(r);
      const cls = c.cls ? c.cls(r) : '';
      return `<td class="${v === '—' ? 'dim' : cls}">${v}</td>`;
    }).join('') + `<td class="dim" style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(r.observacoes || '')}</td>
      <td><div class="rowbtns">
        <button class="rowbtn" data-edit="${r.id}" title="Editar">✎</button>
        <button class="rowbtn del" data-del="${r.id}" title="Excluir">🗑</button>
      </div></td></tr>`).join('') + '</tbody>';

  tbl.querySelectorAll('th[data-key]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.key;
    if (sortHist.key === k) sortHist.dir *= -1; else sortHist = { key: k, dir: -1 };
    renderAdsHist();
  }));
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
  $('a_campanha').value = r.campanha || 'principal';
  $('a_gasto').value = numToInput(r.gasto);
  $('a_cpm').value = numToInput(r.cpm);
  $('a_cpc').value = numToInput(r.cpc);
  $('a_cliques').value = numToInput(r.cliques);
  $('a_ctr').value = numToInput(r.ctr);
  $('a_compras').value = numToInput(r.compras);
  $('a_cpa').value = numToInput(r.custo_por_compra);
  $('a_faturado').value = numToInput(r.faturado);
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
  $('a_campanha').value = 'principal';
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
    campanha: $('a_campanha').value.trim() || 'principal',
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
      const dup = adRows.find(r => r.data === rec.data && r.anuncio === rec.anuncio && r.campanha === rec.campanha);
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
const csvNum = v => v == null ? '' : String(v).replace('.', ',');
const csvTxt = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;

function exportCsvGeral() {
  const list = filterByPeriod(rows);
  if (!list.length) return toast('Nada para exportar.', true);
  const headers = ['data', 'campanha', 'gasto', 'faturado', 'roi', 'taxa_conversao_checkout', 'compras', 'finalizacao_compra', 'cpm', 'cpc', 'cliques', 'visualizacao_destino', 'perda_trafego', 'valor_compras_frontend', 'valor_compras_backend', 'observacoes'];
  const lines = list.map(r => [
    r.data, csvTxt(r.campanha), csvNum(r.gasto), csvNum(r.faturado), csvNum(roiOf(r)), csvNum(taxaOf(r)),
    csvNum(r.compra), csvNum(r.finalizacao_compra), csvNum(r.cpm), csvNum(r.cpc), csvNum(r.cliques),
    csvNum(r.visualizacao_destino), csvNum(r.perda_trafego), csvNum(r.valor_compras_frontend), csvNum(r.valor_compras_backend), csvTxt(r.observacoes),
  ].join(';'));
  downloadCSV(`metricas_${todayISO()}.csv`, headers, lines);
}
function exportCsvAds() {
  const list = filterByPeriod(adRows);
  if (!list.length) return toast('Nada para exportar.', true);
  const headers = ['data', 'anuncio', 'campanha', 'status', 'gasto', 'cpm', 'cpc', 'cliques', 'ctr', 'compras', 'custo_por_compra', 'faturado', 'roi', 'hook_rate', 'retencao_video', 'frequencia', 'observacoes'];
  const lines = list.map(r => [
    r.data, csvTxt(r.anuncio), csvTxt(r.campanha), r.status, csvNum(r.gasto), csvNum(r.cpm), csvNum(r.cpc),
    csvNum(r.cliques), csvNum(r.ctr), csvNum(r.compras), csvNum(cpaOf(r)), csvNum(r.faturado), csvNum(adRoiOf(r)),
    csvNum(r.hook_rate), csvNum(r.retencao_video), csvNum(r.frequencia), csvTxt(r.observacoes),
  ].join(';'));
  downloadCSV(`anuncios_${todayISO()}.csv`, headers, lines);
}

/* =================================================================
   Dados / render geral
================================================================= */
async function loadData() {
  const [g, a] = await Promise.all([
    db.from('ads_metricas_diarias').select('*').order('data', { ascending: true }),
    db.from('ads_anuncios_diarios').select('*').order('data', { ascending: true }),
  ]);
  if (g.error) { toast('Erro ao carregar: ' + g.error.message, true); return; }
  if (a.error) { toast('Erro ao carregar: ' + a.error.message, true); return; }
  rows = (g.data || []).map(coerceGeral);
  adRows = (a.data || []).map(coerceAd);
  renderAll();
}
function coerceGeral(r) {
  for (const k of ['gasto', 'faturado', 'valor_compras_frontend', 'valor_compras_backend', 'cpm', 'cpc', 'perda_trafego', 'taxa_conversao_checkout', 'roi'])
    if (r[k] != null) r[k] = Number(r[k]);
  return r;
}
function coerceAd(r) {
  for (const k of ['gasto', 'cpm', 'cpc', 'ctr', 'custo_por_compra', 'faturado', 'roi', 'hook_rate', 'retencao_video', 'frequencia'])
    if (r[k] != null) r[k] = Number(r[k]);
  return r;
}
function renderAll() {
  renderKpis();
  renderCharts();
  renderTableGeral();
  renderAdDatalist();
  renderRanking();
  renderCompare();
  renderAdsHist();
}

/* =================================================================
   Auth + boot
================================================================= */
function showLogin() {
  $('splash').classList.add('hidden');
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}
async function enterApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  await loadData();
  $('splash').classList.add('hidden');
}

async function boot() {
  /* período salvo */
  const savedPeriod = parseInt(localStorage.getItem('ads_dash_period') || '0', 10);
  if ([0, 1, 7, 30].includes(savedPeriod)) period = savedPeriod;
  syncPeriodChips();

  /* forms */
  $('f_data').value = todayISO();
  $('a_data').value = todayISO();
  if (window.innerWidth > 860) { $('formCardGeral').open = true; }

  $('formGeral').addEventListener('submit', saveGeral);
  $('formAds').addEventListener('submit', saveAd);
  $('btnCancelGeral').addEventListener('click', resetFormGeral);
  $('btnCancelAds').addEventListener('click', resetFormAds);
  for (const id of ['f_gasto', 'f_faturado', 'f_finalizacao', 'f_compra']) $(id).addEventListener('input', updatePreviewsGeral);
  for (const id of ['a_gasto', 'a_faturado', 'a_compras']) $(id).addEventListener('input', updatePreviewsAds);

  /* tabs */
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    $('tab-geral').classList.toggle('hidden', t.dataset.tab !== 'geral');
    $('tab-anuncios').classList.toggle('hidden', t.dataset.tab !== 'anuncios');
  }));

  /* período */
  document.querySelectorAll('#periodChips .chip, #periodChipsAds .chip').forEach(c => c.addEventListener('click', () => {
    period = parseInt(c.dataset.days, 10);
    localStorage.setItem('ads_dash_period', String(period));
    syncPeriodChips();
    renderAll();
  }));

  /* csv */
  $('btnCsvGeral').addEventListener('click', exportCsvGeral);
  $('btnCsvAds').addEventListener('click', exportCsvAds);

  /* comparação */
  $('cmpMetric').addEventListener('change', renderCompare);
  $('histAdFilter').addEventListener('change', renderAdsHist);

  /* settings */
  $('btnSettings').addEventListener('click', () => {
    $('s_roi').value = numToInput(settings.roiMin);
    $('s_perda').value = numToInput(settings.perdaMax);
    $('s_spike').value = numToInput(settings.spikePct);
    $('settingsModal').classList.remove('hidden');
  });
  $('btnCloseSettings').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
  $('settingsModal').addEventListener('click', e => { if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden'); });
  $('btnSaveSettings').addEventListener('click', () => {
    settings.roiMin = parseNum($('s_roi').value) ?? DEFAULT_SETTINGS.roiMin;
    settings.perdaMax = parseNum($('s_perda').value) ?? DEFAULT_SETTINGS.perdaMax;
    settings.spikePct = parseNum($('s_spike').value) ?? DEFAULT_SETTINGS.spikePct;
    localStorage.setItem('ads_dash_settings', JSON.stringify(settings));
    $('settingsModal').classList.add('hidden');
    toast('Alertas atualizados ✓');
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

  const { data: { session } } = await db.auth.getSession();
  if (session) await enterApp();
  else showLogin();
}

function syncPeriodChips() {
  document.querySelectorAll('#periodChips .chip, #periodChipsAds .chip').forEach(c =>
    c.classList.toggle('active', parseInt(c.dataset.days, 10) === period));
}

boot();
