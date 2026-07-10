/* ===== Métricas — Tráfego Pago · app ===== */
'use strict';

/* ---------- Supabase ---------- */
const SUPABASE_URL = 'https://nyuycffqncuavzuhyofq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_soW7Jl52hpZYkaJtmDT6tg_4111FV8W';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- Estado ---------- */
let uid = null;     // dono da sessão. Toda linha é dele; o RLS confere no servidor.
let userEmail = '';
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

/* ---------- Paleta ----------
   SERIES e RAMP são DADO: validadas por acessibilidade, não se mexe.
   O ouro (--gold) é MARCA: só aparece como limiar (horizonte/zonas), nunca
   como valor plotado. Espelha os tokens de css/style.css. */
const SERIES = ['#3987e5', '#199e70', '#c98500', '#9085e9', '#e66767', '#d55181', '#d95926', '#008300'];
const RAMP = ['#9ec5f4', '#5598e7', '#256abf'];   // rampa ordinal do funil (validada --ordinal)
const C = {
  text: '#F4F3EE', text2: '#A6A199', muted: '#6E6960', grid: '#23232a', zero: '#3a3a42',
  card: '#131318', card2: '#1B1B22', good: '#34c759', bad: '#e66767', ref: '#5a564e',
  gold: '#C8A86A', goldDim: '#8A7448',
};

/* Com mais de 8 criativos as cores começavam a repetir e viravam ambíguas.
   Depois das 8 validadas, giramos a matiz com S/L fixos. */
function corDaSerie(i) {
  if (i < SERIES.length) return SERIES[i];
  const h = (i * 47) % 360;
  return `hsl(${h} 55% ${i % 2 ? 68 : 56}%)`;
}

/* ---------- Helpers de número/data (pt-BR) ---------- */
const nfBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

function parseNum(str) {
  if (str === null || str === undefined) return null;
  let s = String(str).trim().replace(/R\$|%|\s/g, '');
  if (!s) return null;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    /* "1.234" vem do Gerenciador do Meta como milhar, não decimal — sem isto,
       1.234 cliques viram 1. Só grupos de exatamente 3 dígitos casam, então
       "75.58" continua sendo decimal. */
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : (neg ? -n : n);
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

/* `new Date('2026-07-09')` é meia-noite UTC; getDate()/setDate() são locais.
   Misturar os dois desloca a data um dia em BRT. Sempre construa local. */
function isoToDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function isoAdd(iso, dias) { const d = isoToDate(iso); d.setDate(d.getDate() + dias); return isoOf(d); }
function isoDiffDias(a, b) { return Math.round((isoToDate(b) - isoToDate(a)) / 86400000); }
function ontemISO() { return isoAdd(todayISO(), -1); }

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
/* CPC é override, não fonte da verdade: a tabela mostrava o digitado enquanto o
   KPI mostrava gasto÷cliques — dois números com o mesmo rótulo na mesma tela. */
function cpcOf(r) { return r.cpc != null ? Number(r.cpc) : (r.cliques > 0 && r.gasto != null ? r.gasto / r.cliques : null); }
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
  const dias = isoDiffDias(ini, fim) + 1;
  const b = isoAdd(ini, -1);          // véspera do início da janela atual
  const a = isoAdd(b, -(dias - 1));   // mesmo tamanho, imediatamente antes
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

/* =================================================================
   ergozones — a assinatura do Ergosphere.
   Pinta o gráfico de ROAS em três regiões físicas:
     dentro do horizonte  (< breakeven)     nada volta
     a ergosfera          (breakeven→alvo)  ainda dá pra extrair energia
     escapou              (> alvo)          saiu com lucro
   Desenha ANTES dos datasets: é fundo, não dado.
   Recebe só números puros — função em options.plugins.* o Chart.js
   resolveria como "scriptable" e chamaria com um contexto interno.
================================================================= */
const ergozonesPlugin = {
  id: 'ergozones',
  beforeDatasetsDraw(chart) {
    const o = chart.options.plugins?.ergozones;
    if (!o || o.horizon == null) return;
    const { ctx, chartArea, scales } = chart;
    const { top, bottom, left, right } = chartArea;
    const clamp = v => Math.max(top, Math.min(bottom, v));
    const yH = clamp(scales.y.getPixelForValue(o.horizon));
    const yT = o.target != null ? clamp(scales.y.getPixelForValue(o.target)) : top;

    ctx.save();
    ctx.fillStyle = 'rgba(230, 103, 103, 0.07)';   // dentro do horizonte
    ctx.fillRect(left, yH, right - left, bottom - yH);
    ctx.fillStyle = 'rgba(200, 168, 106, 0.09)';   // a ergosfera
    ctx.fillRect(left, yT, right - left, yH - yT);
    ctx.fillStyle = 'rgba(52, 199, 89, 0.06)';     // escapou
    ctx.fillRect(left, top, right - left, yT - top);

    /* o horizonte de eventos: a única linha em ouro, porque é limiar */
    if (yH > top && yH < bottom) {
      ctx.strokeStyle = C.gold;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, yH); ctx.lineTo(right, yH); ctx.stroke();
      ctx.fillStyle = C.gold;
      ctx.font = '600 9.5px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('HORIZONTE DE EVENTOS', left + 4, yH - 5);
    }
    if (o.target != null && yT > top + 8 && yT < bottom) {
      ctx.strokeStyle = C.goldDim;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(left, yT); ctx.lineTo(right, yT); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.muted;
      ctx.font = '600 9.5px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('ALVO', right - 4, yT - 5);
    }
    ctx.restore();
  },
};

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
      /* barra flutuante da cascata: o valor é o degrau, e o rótulo vai
         depois da ponta mais à direita — que num degrau negativo é a base */
      if (opt.kind === 'cascata') {
        const [a, b] = Array.isArray(raw) ? raw : [0, raw];
        const sc = chart.scales.x;
        const px = Math.max(sc.getPixelForValue(a), sc.getPixelForValue(b)) + 8;
        ctx.fillText(fmtBRL(b - a), px, bar.y);
        return;
      }
      let txt;
      if (opt.kind === 'money') txt = fmtBRL(raw);
      else if (opt.kind === 'funil') txt = `${nf0.format(raw)}${opt.topo ? `  ${nf0.format((raw / opt.topo) * 100)}%` : ''}`;
      else txt = nf0.format(raw);
      ctx.fillText(txt, bar.x + 8, bar.y);
    });
    ctx.restore();
  },
};

Chart.register(reflinePlugin, annotPlugin, endLabelPlugin, ergozonesPlugin);

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

/* Abaixo disto, uma série temporal é um ponto solto — parece bug, não dado. */
const MIN_DIAS_GRAFICO = 3;
function placeholderGrafico(boxId, canvasId, faltam) {
  const box = $(boxId);
  if (!box) return;
  destroyChart(canvasId);
  const el = document.getElementById(canvasId);
  if (el) Chart.getChart(el)?.destroy();
  box.classList.add('chartwait');
  box.innerHTML = `<div class="accretion sm" style="opacity:.32"></div>
    <span>O gráfico acende com ${MIN_DIAS_GRAFICO} dias lançados.<br>
    ${faltam === 1 ? 'Falta 1 dia.' : `Faltam ${faltam} dias.`}</span>`;
}
function restaurarCanvas(boxId, canvasId) {
  const box = $(boxId);
  if (!box || box.querySelector('canvas')) return;
  box.classList.remove('chartwait');
  box.innerHTML = `<canvas id="${canvasId}"></canvas>`;
}

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
function kpiCard(label, value, sub, cls, alert, extra) {
  return `<div class="kpi${alert ? ' alert' : ''}">
    <div class="klabel">${label}</div>
    <div class="kvalue ${cls || ''}">${value}</div>
    ${sub || '<div class="kdelta">—</div>'}
    ${extra || ''}
  </div>`;
}

/* A régua de horizonte: um bullet graph do ROAS contra o breakeven.
   Barra = dado (semântico). Marcador = limiar (ouro). */
function reguaHorizonte(roas) {
  const be = breakevenRoas();
  if (roas == null || be == null || be <= 0) return '';
  const alvo = roasAlvo() || be * 1.2;
  const esc = Math.max(roas, alvo) * 1.12;
  const pct = v => Math.max(0, Math.min(100, (v / esc) * 100));
  const acima = roas >= be;
  return `<div class="horizonbar">
      <div class="fill ${acima ? '' : 'bad'}" style="width:${pct(roas).toFixed(1)}%"></div>
      <div class="mark" style="left:${pct(be).toFixed(1)}%"></div>
    </div>
    <div class="horizoncap">${acima ? 'fora do' : 'dentro do'} <b>horizonte ${fmtDec(be)}</b></div>`;
}

/**
 * REGRA DE OURO: no DIA mostra "quanto" (R$, contagens); no PERÍODO mostra
 * "quão bem" (ratios). Com ~2 vendas/dia, margem e ROAS de um dia isolado são
 * ruído quantizado — valem 0 ou ticket/gasto, nada entre.
 * @param {'dia'|'periodo'} nivel
 */
function bandKpis(t, tPrev, nivel) {
  const lucroCls = t.lucro == null ? '' : (t.lucro >= 0 ? 'good' : 'bad');
  const be = breakevenRoas();

  if (nivel === 'dia') {
    return [
      kpiCard('Lucro', fmtBRL(t.lucro), deltaHtml(t.lucro, tPrev?.lucro, true), lucroCls, t.lucro != null && t.lucro < 0),
      kpiCard('Gasto', fmtBRL(t.gasto), deltaHtml(t.gasto, tPrev?.gasto, null)),
      kpiCard('Faturado', fmtBRL(t.faturado), deltaHtml(t.faturado, tPrev?.faturado, true)),
      kpiCard('Compras', fmtNum(t.compra), deltaHtml(t.compra, tPrev?.compra, true)),
      kpiCard('Cliques', fmtNum(t.cliques), deltaHtml(t.cliques, tPrev?.cliques, true)),
    ].join('');
  }

  const margemCls = t.margem == null ? '' : (t.margem >= 0 ? 'good' : 'bad');
  const roasCls = t.roas == null || be == null ? '' : (t.roas >= be ? 'good' : 'bad');
  return [
    kpiCard('Lucro', fmtBRL(t.lucro), deltaHtml(t.lucro, tPrev?.lucro, true), lucroCls, t.lucro != null && t.lucro < 0),
    kpiCard('Margem', fmtPct(t.margem), deltaHtml(t.margem, tPrev?.margem, true), margemCls),
    kpiCard('ROAS', t.roas == null ? '—' : fmtDec(t.roas), deltaHtml(t.roas, tPrev?.roas, true), roasCls, false, reguaHorizonte(t.roas)),
    kpiCard(temEconomia() ? 'Receita líquida' : 'Faturamento', fmtBRL(temEconomia() ? t.liquido : t.faturado), deltaHtml(temEconomia() ? t.liquido : t.faturado, temEconomia() ? tPrev?.liquido : tPrev?.faturado, true)),
    kpiCard('Gasto', fmtBRL(t.gasto), deltaHtml(t.gasto, tPrev?.gasto, null)),
  ].join('');
}

function renderKpis() {
  const asc = [...rows].sort((a, b) => a.data.localeCompare(b.data));
  const last = asc[asc.length - 1];
  const prev = asc[asc.length - 2];

  $('ecoHint').textContent = temEconomia()
    ? `descontando ${nf2.format(dedPct())}% de taxa+imposto · horizonte de eventos em ROAS ${fmtDec(breakevenRoas())}`
    : 'lucro estimado no bruto — configure a economia do projeto em Conta';

  $('labelDia').textContent = last ? `Último dia · ${fmtData(last.data)} · quanto entrou e saiu` : 'Último dia';
  $('kpiDia').innerHTML = last ? bandKpis(totais([last]), prev ? totais([prev]) : null, 'dia') : '<p class="empty">Sem lançamentos.</p>';

  const lista = filterByPeriod(rows);
  const t = totais(lista);
  const tPrev = totais(janelaAnterior(rows));
  $('labelPeriodo').textContent = `Período · ${periodLabel()}${lista.length ? ` · ${lista.length} ${lista.length === 1 ? 'dia' : 'dias'}` : ''}`;
  $('kpiPeriodo').innerHTML = lista.length ? bandKpis(t, tPrev.dias ? tPrev : null, 'periodo') : '<p class="empty">Nada no período.</p>';

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
/** @param {HTMLElement} [alvo] onde desenhar; por padrão o bloco da Visão Geral */
function renderVeredito(alvo) {
  const lista = filterByPeriod(rows);
  const box = alvo || $('veredito');
  if (!box) return;
  if (lista.length < 2) { box.className = 'diag dim'; box.innerHTML = `<div class="diaghead"><span class="verdict dim">Coletando dados</span><span class="vsum">Lance mais dias para o painel conseguir ler tendência.</span></div>`; return; }

  const t = totais(lista);
  const be = breakevenRoas();
  let streak = 0;
  for (let i = lista.length - 1; i >= 0; i--) { const l = lucroOf(lista[i]); if (l != null && l < 0) streak++; else break; }

  let verdict, cls, sum;
  if (t.lucro > 0 && streak === 0) { verdict = 'No lucro'; cls = 'good'; sum = `${fmtBRL(t.lucro)} de lucro em ${lista.length} dias — ROAS ${fmtDec(t.roas)} contra o horizonte de ${fmtDec(be)}.`; }
  else if (t.lucro > 0) { verdict = 'Atenção'; cls = 'warn'; sum = `Acumulado positivo (${fmtBRL(t.lucro)}), mas os últimos ${streak} ${streak === 1 ? 'dia fechou' : 'dias fecharam'} no vermelho.`; }
  else { verdict = 'No prejuízo'; cls = 'bad'; sum = `${fmtBRL(t.lucro)} no período. ROAS ${fmtDec(t.roas)} está abaixo do breakeven de ${fmtDec(be)}.`; }

  const notes = [];
  if (!temEconomia()) notes.push({ dir: '', html: 'Economia do projeto zerada — o lucro está <b>estimado no bruto</b>. Configure a taxa do gateway em <b>Conta</b>.' });
  if (t.compra > 0) notes.push({ dir: t.cpa <= (cpaAlvo() ?? Infinity) ? 'up' : 'down', html: `Custo por compra de <b>${fmtBRL(t.cpa)}</b>${cpaAlvo() != null ? ` — o alvo para manter ${nf0.format(num(eco.margem_alvo_pct))}% de margem é ${fmtBRL(cpaAlvo())}` : ''}.` });
  /* a fase de aprendizado saiu daqui: virou medidor próprio na tela Hoje */
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

  /* 2. Lucro acumulado — linha com 1 ponto parece bug, não dado */
  if (list.length < MIN_DIAS_GRAFICO) {
    placeholderGrafico('boxLucroAcum', 'chLucroAcum', MIN_DIAS_GRAFICO - list.length);
  } else {
    restaurarCanvas('boxLucroAcum', 'chLucroAcum');
    let acc = 0;
    const acumulado = lucros.map(v => { if (v == null) return null; acc += v; return acc; });
    const acumOpts = baseOptions(money, { plugins: { refline: { y: 0, color: C.zero, dash: false }, xannot: annots }, y: { beginAtZero: false } });
    acumOpts.plugins.tooltip.callbacks.footer = footer;
    makeChart('chLucroAcum', {
      type: 'line',
      data: { labels, datasets: [lineDataset('Lucro acumulado', acumulado, SERIES[0], true, false)] },
      options: acumOpts,
    });
  }

  /* 3. ROAS dentro das três zonas do buraco negro */
  const be = breakevenRoas();
  const alvo = roasAlvo();
  $('roasSub').textContent = be != null ? `· horizonte ${fmtDec(be)} · alvo ${fmtDec(alvo)}` : '';
  if (list.length < MIN_DIAS_GRAFICO) {
    /* ROAS é ratio: com 1-2 dias e ~2 vendas/dia isso é ruído quantizado, não sinal */
    placeholderGrafico('boxRoas', 'chRoas', MIN_DIAS_GRAFICO - list.length);
  } else {
    restaurarCanvas('boxRoas', 'chRoas');
    const roasOpts = baseOptions(v => fmtDec(v), {
      plugins: { ergozones: be != null ? { horizon: be, target: alvo } : undefined, xannot: annots },
      y: { suggestedMax: Math.max(1.2, (alvo || 1.2) * 1.15) },
    });
    roasOpts.plugins.tooltip.callbacks.footer = footer;
    makeChart('chRoas', {
      type: 'line',
      data: { labels, datasets: [lineDataset('ROAS', list.map(roasOf), SERIES[0], false, false)] },
      options: roasOpts,
    });
  }

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
  { key: 'cpc', label: 'CPC', get: r => cpcOf(r), fmt: r => fmtBRL(cpcOf(r)), spike: 'cpc' },
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
    <td><button class="rowbtn txt" data-ana="${esc(a.anuncio)}" title="Analisar este anúncio">Analisar →</button></td>
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
  if (!list.length) {
    tbl.innerHTML = '';
    destroyChart('chDiaAds');
    $('emptyGeral').innerHTML = noSignal(
      rows.length ? 'Nada neste período' : 'Nada em órbita ainda',
      rows.length ? 'Amplie o filtro de período acima para ver os dias que você já lançou.'
                  : 'Cada dia lançado é uma órbita. A primeira é a mais importante.',
      rows.length ? null : { acao: 'lancar-dia', txt: 'Lançar o primeiro dia' });
    ligarAcoes($('emptyGeral'));
    return;
  }

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
/* O lançamento real quase sempre é o de ontem — o dia de hoje ainda não fechou.
   Se ontem já está lançado, o alvo passa a ser hoje. */
function dataPadraoDia() {
  const ontem = ontemISO();
  return rows.some(r => r.data === ontem) ? todayISO() : ontem;
}
function resetFormGeral() {
  editingId = null;
  $('formGeral').reset();
  $('f_data').value = dataPadraoDia();
  $('editTagGeral').classList.add('hidden');
  $('btnCancelGeral').classList.add('hidden');
  $('btnSalvarGeral').textContent = 'Salvar dia';
  updatePreviewsGeral();
}
function collectGeral() {
  return {
    data: $('f_data').value,
    campanha: projeto,
    user_id: uid,
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
  $('f_cpc').placeholder = (rec.cliques > 0 && gasto != null) ? 'auto: ' + nf2.format(gasto / rec.cliques) : 'auto';

  const l = lucroOf(rec);
  if (l == null) { $('previewDia').textContent = `Lançando no projeto ${projeto}.`; return; }
  const m = margemOf(rec), ro = roasOf(rec);
  $('previewDia').innerHTML = `No projeto <b>${esc(projeto)}</b> · lucro <b class="${l >= 0 ? 'up' : 'down'}">${fmtBRL(l)}</b>${m != null ? ` · margem ${fmtPct(m)}` : ''}${ro != null ? ` · ROAS ${fmtDec(ro)}` : ''}${temEconomia() ? '' : ' (bruto)'}`;
}

/* somar os anúncios daquele dia no form */
async function somarDosAnuncios() {
  const dia = $('f_data').value;
  if (!dia) return toast('Escolha a data primeiro.', true);
  const doDia = adRows.filter(a => a.data === dia);
  if (!doDia.length) return toast(`Nenhum anúncio lançado em ${fmtData(dia)}.`, true);

  /* não sobrescreve o que já foi digitado sem avisar */
  const jaTem = ['f_gasto', 'f_faturado', 'f_compra', 'f_cliques'].filter(id => $(id).value.trim());
  if (jaTem.length && !await confirmar({
    titulo: 'Substituir o que já está preenchido?',
    texto: `Gasto, faturado, compras e cliques serão recalculados a partir dos ${doDia.length} criativos de ${fmtData(dia)}.`,
    ok: 'Substituir',
  })) return;

  const s = doDia.reduce((acc, a) => ({
    gasto: acc.gasto + num(a.gasto), faturado: acc.faturado + num(a.faturado),
    compras: acc.compras + num(a.compras), cliques: acc.cliques + num(a.cliques),
    impressoes: acc.impressoes + (a.cpm > 0 ? (num(a.gasto) / Number(a.cpm)) * 1000 : 0),
  }), { gasto: 0, faturado: 0, compras: 0, cliques: 0, impressoes: 0 });

  $('f_gasto').value = numToInput(Number(s.gasto.toFixed(2)));
  $('f_faturado').value = numToInput(Number(s.faturado.toFixed(2)));
  $('f_compra').value = String(s.compras);
  if (s.cliques) $('f_cliques').value = String(s.cliques);
  /* CPM do dia é média ponderada por impressões, não média das médias */
  if (s.impressoes > 0) $('f_cpm').value = numToInput(Number(((s.gasto / s.impressoes) * 1000).toFixed(2)));

  updatePreviewsGeral();
  toast(`Somados ${doDia.length} ${doDia.length === 1 ? 'criativo' : 'criativos'} de ${fmtData(dia)} ✓`);
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
      if (dup && !await confirmar({
        titulo: 'Sobrescrever o dia?',
        texto: `Já existe lançamento em ${fmtData(rec.data)}.`,
        ok: 'Sobrescrever',
      })) { $('btnSalvarGeral').disabled = false; return; }
      const { error } = await db.from('ads_metricas_diarias').upsert(rec, { onConflict: 'user_id,data,campanha' });
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
  if (!r) return;
  if (!await confirmar({ titulo: `Excluir ${fmtData(r.data)}?`, texto: 'O lançamento desse dia será apagado.', ok: 'Excluir', perigo: true })) return;
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
  order.forEach((name, i) => { map[name] = corDaSerie(i); });
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
    { const c = cpcOf(r); if (c != null) a.cpcs.push(c); }
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
  if (!ags.length) {
    tbl.innerHTML = '';
    $('emptyRanking').innerHTML = noSignal(
      'Nenhum criativo em órbita',
      'Lance os criativos de um dia e o Ergosphere passa a dizer qual cortar, qual manter e qual escalar.',
      { acao: 'lancar-anuncio', txt: 'Lançar anúncio' });
    ligarAcoes($('emptyRanking'));
    return;
  }

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
  const tCpc = trendPct(days, cpcOf);
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

  makeChart('anaCpc', { type: 'line', data: { labels, datasets: [lineDataset('CPC', days.map(cpcOf), SERIES[0], true, false)] }, options: miniOptions(days, money2) });
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
        ${cellWithDelta(fmtBRL(cpcOf(r)), cpcOf(r), p ? cpcOf(p) : null, false)}
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
  if (!has) {
    $('anaEmpty').innerHTML = noSignal('Sem sinal',
      'Lance criativos para ver a evolução de cada um, dia a dia, com veredito automático.',
      { acao: 'lancar-anuncio', txt: 'Lançar anúncio' });
    ligarAcoes($('anaEmpty'));
    return;
  }

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
  { key: 'cpc', label: 'CPC', get: r => cpcOf(r), fmt: r => fmtBRL(cpcOf(r)) },
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
  if (!list.length) {
    tbl.innerHTML = '';
    $('emptyAdsHist').innerHTML = noSignal('Nada neste período',
      'Nenhum criativo tem lançamento no intervalo selecionado.', null);
    return;
  }

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
/**
 * @param {string} [manterData] mantém esta data no form em vez de voltar pra hoje.
 * Lançar 11 criativos do mesmo dia não pode custar 11 redigitações de data.
 */
function resetFormAds(manterData) {
  editingAdId = null;
  $('formAds').reset();
  $('a_data').value = manterData || todayISO();
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
    user_id: uid,
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
  const gasto = parseNum($('a_gasto').value), fat = parseNum($('a_faturado').value);
  const comp = parseNum($('a_compras').value), cliq = parseNum($('a_cliques').value);
  $('a_roi').placeholder = (gasto > 0 && fat != null) ? 'auto: ' + nf2.format(fat / gasto) : 'auto';
  $('a_cpa').placeholder = (comp > 0 && gasto != null) ? 'auto: ' + nf2.format(gasto / comp) : 'auto';
  $('a_cpc').placeholder = (cliq > 0 && gasto != null) ? 'auto: ' + nf2.format(gasto / cliq) : 'auto';
}

async function saveAd(e) {
  e.preventDefault();
  const rec = collectAds();
  if (!rec.data) return toast('Escolha a data.', true);
  if (!rec.anuncio) return toast('Dê um nome ao anúncio.', true);
  const eraEdicao = !!editingAdId;
  $('btnSalvarAds').disabled = true;
  try {
    if (editingAdId) {
      const { error } = await db.from('ads_anuncios_diarios').update(rec).eq('id', editingAdId);
      if (error) throw error;
      toast('Anúncio atualizado ✓');
    } else {
      const dup = adRows.find(r => r.data === rec.data && r.anuncio === rec.anuncio);
      if (dup && !await confirmar({
        titulo: 'Sobrescrever lançamento?',
        texto: `"${rec.anuncio}" já tem lançamento em ${fmtData(rec.data)}.`,
        ok: 'Sobrescrever',
      })) { $('btnSalvarAds').disabled = false; return; }
      const { error } = await db.from('ads_anuncios_diarios').upsert(rec, { onConflict: 'user_id,data,anuncio,campanha' });
      if (error) throw error;
      if (selectedAds) selectedAds.add(rec.anuncio);
      toast('Anúncio lançado ✓');
    }
    resetFormAds(rec.data);          // mantém a data: o próximo criativo é do mesmo dia
    await loadData();
    if (!eraEdicao) { $('formCardAds').open = true; $('a_anuncio').focus(); }
  } catch (err) {
    toast('Erro ao salvar: ' + (err.message || err), true);
  }
  $('btnSalvarAds').disabled = false;
}
async function delAd(id) {
  const r = adRows.find(x => x.id === id);
  if (!r) return;
  if (!await confirmar({ titulo: `Excluir "${r.anuncio}"?`, texto: `Apenas o lançamento de ${fmtData(r.data)}.`, ok: 'Excluir', perigo: true })) return;
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
    csvNum(r.cpm), csvNum(cpcOf(r)), csvNum(r.cliques), csvNum(r.visualizacao_destino), csvNum(perdaOf(r)),
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
    csvNum(r.compras), csvNum(cpaAdOf(r)), csvNum(r.cpm), csvNum(cpcOf(r)), csvNum(r.cliques), csvNum(r.ctr),
    csvNum(r.hook_rate), csvNum(r.retencao_video), csvNum(r.frequencia), csvTxt(r.observacoes),
  ].join(';'));
  downloadCSV(`anuncios_${slug(projeto)}_${todayISO()}.csv`, headers, lines);
}

/* =================================================================
   PROJETOS
================================================================= */
async function loadProjetos() {
  const { data, error } = await db.from('ads_projetos').select('*').eq('user_id', uid).order('nome');
  if (error) { toast('Erro ao carregar projetos: ' + error.message, true); return; }
  projetos = data || [];
  if (!projetos.length) {
    const ins = await db.from('ads_projetos').insert({ nome: 'principal', user_id: uid }).select();
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
  const nome = (await pedirTexto({ titulo: 'Novo projeto', placeholder: 'ex.: Rasga Xana', ok: 'Criar' }) || '').trim();
  if (!nome) return;
  if (projetos.some(p => p.nome.toLowerCase() === nome.toLowerCase())) return toast('Já existe um projeto com esse nome.', true);
  const { error } = await db.from('ads_projetos').insert({ nome, user_id: uid });
  if (error) return toast('Erro ao criar: ' + error.message, true);
  setProjeto(nome, true);
  await loadProjetos();
  await loadData();
  toast(`Projeto "${nome}" criado ✓`);
}

async function renomearProjeto() {
  const nome = (await pedirTexto({ titulo: 'Renomear projeto', valor: projeto, ok: 'Renomear' }) || '').trim();
  if (!nome || nome === projeto) return;
  if (projetos.some(p => p.nome.toLowerCase() === nome.toLowerCase())) return toast('Já existe um projeto com esse nome.', true);
  const antigo = projeto;
  let { error } = await db.from('ads_projetos').update({ nome }).eq('nome', antigo).eq('user_id', uid);
  if (error) return toast('Erro ao renomear: ' + error.message, true);
  for (const t of ['ads_metricas_diarias', 'ads_anuncios_diarios']) {
    const r = await db.from(t).update({ campanha: nome }).eq('campanha', antigo).eq('user_id', uid);
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
  const conf = await pedirTexto({
    titulo: `Excluir "${projeto}"?`,
    texto: `Isso apaga ${rows.length} ${rows.length === 1 ? 'dia' : 'dias'} e ${nAds} ${nAds === 1 ? 'anúncio' : 'anúncios'}. Não dá pra desfazer.\n\nDigite o nome do projeto para confirmar:`,
    ok: 'Excluir para sempre',
    perigo: true,
  });
  if (conf == null) return;
  if (conf.trim() !== projeto) return toast('Nome não confere — nada foi excluído.', true);
  for (const t of ['ads_metricas_diarias', 'ads_anuncios_diarios']) {
    const r = await db.from(t).delete().eq('campanha', projeto).eq('user_id', uid);
    if (r.error) return toast('Erro ao excluir: ' + r.error.message, true);
  }
  const { error } = await db.from('ads_projetos').delete().eq('nome', projeto).eq('user_id', uid);
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
  if (!await confirmar({
    titulo: `Excluir "${nome}"?`,
    texto: `Apaga os ${dias} ${dias === 1 ? 'dia lançado' : 'dias lançados'} desse criativo.`,
    ok: 'Excluir', perigo: true,
  })) return;
  const { error } = await db.from('ads_anuncios_diarios').delete().eq('campanha', projeto).eq('anuncio', nome).eq('user_id', uid);
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
    db.from('ads_metricas_diarias').select('*').eq('user_id', uid).eq('campanha', projeto).order('data', { ascending: true }),
    db.from('ads_anuncios_diarios').select('*').eq('user_id', uid).eq('campanha', projeto).order('data', { ascending: true }),
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
  renderHoje();
  /* só a aba visível desenha: renderAll roda a cada tecla do form, e recriar
     ~12 Charts das duas abas a cada vez é caro à toa. */
  if (abaAtiva === 'geral') {
    renderKpis();
    renderVeredito();
    renderCascata();
    renderCharts();
    renderFunil();
    renderTableGeral();
  }
  renderAdDatalist();
  if (abaAtiva === 'anuncios') {
    renderRanking();
    renderAnalise();
    renderCompare();
    renderAdsHist();
  }
  if (abaAtiva === 'diario') renderDiario();
  if (abaAtiva === 'conta') renderConta();
  updatePreviewsGeral();
}

/* =================================================================
   ESTADO-VAZIO — "no signal".
   É a tela que ele mais vê. Ela é a vitrine, não o rodapé.
================================================================= */
function noSignal(titulo, texto, botao) {
  return `<div class="nosignal">
    <div class="accretion"></div>
    <h4>${titulo}</h4>
    <p>${texto}</p>
    ${botao ? `<button class="btn primary" data-acao="${botao.acao}">${botao.txt}</button>` : ''}
  </div>`;
}
function ligarAcoes(root) {
  (root || document).querySelectorAll('[data-acao]').forEach(b => {
    if (b.dataset.ligado) return;
    b.dataset.ligado = '1';
    b.addEventListener('click', () => acao(b.dataset.acao));
  });
}
function acao(nome) {
  if (nome === 'lancar-dia') abrirFormDia();
  else if (nome === 'lancar-anuncio') abrirFormAnuncio();
  else if (nome === 'economia') { trocarAba('conta'); $('s_taxa').focus(); }
  else if (nome === 'geral' || nome === 'anuncios') trocarAba(nome);
}
function abrirFormDia(dataISO) {
  trocarAba('geral');
  if (!editingId) resetFormGeral();
  if (dataISO) $('f_data').value = dataISO;
  $('formCardGeral').open = true;
  $('formCardGeral').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('f_gasto').focus(), 320);
}
function abrirFormAnuncio(dataISO) {
  trocarAba('anuncios');
  if (!editingAdId) resetFormAds(dataISO);
  if (dataISO) $('a_data').value = dataISO;
  $('formCardAds').open = true;
  $('formCardAds').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* =================================================================
   MODAIS PRÓPRIOS — o confirm()/prompt() nativo mostra "github.io diz…"
   e é o maior sinal de que aquilo é "um site", não um app.
================================================================= */
function abrirSheet(html, largo) {
  const host = document.createElement('div');
  host.className = 'modal';
  host.innerHTML = `<div class="sheet${largo ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  $('sheetHost').appendChild(host);
  const foco = host.querySelector('textarea, input, button');
  setTimeout(() => foco?.focus(), 60);
  return host;
}
function fecharSheet(host) { host.remove(); }
/** só a folha do topo responde ao Escape — senão um confirm() fecha a folha de baixo junto */
function noTopo(host) { return $('sheetHost').lastElementChild === host; }

/** @returns {Promise<boolean>} */
function confirmar({ titulo, texto, ok = 'Confirmar', perigo = false }) {
  return new Promise(resolve => {
    const host = abrirSheet(`
      <h3>${esc(titulo)}</h3>
      ${texto ? `<p>${esc(texto)}</p>` : ''}
      <div class="formactions">
        <button class="btn ghost" data-no>Cancelar</button>
        <button class="btn ${perigo ? 'danger' : 'primary'}" data-yes>${esc(ok)}</button>
      </div>`);
    const fim = v => { document.removeEventListener('keydown', onKey); fecharSheet(host); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') fim(false); };
    host.querySelector('[data-yes]').addEventListener('click', () => fim(true));
    host.querySelector('[data-no]').addEventListener('click', () => fim(false));
    host.addEventListener('click', e => { if (e.target === host) fim(false); });
    document.addEventListener('keydown', onKey);
  });
}

/** @returns {Promise<string|null>} null = cancelado */
function pedirTexto({ titulo, texto, valor = '', placeholder = '', ok = 'Salvar', perigo = false }) {
  return new Promise(resolve => {
    const host = abrirSheet(`
      <h3>${esc(titulo)}</h3>
      ${texto ? `<p>${esc(texto)}</p>` : ''}
      <input type="text" data-inp value="${esc(valor)}" placeholder="${esc(placeholder)}" autocomplete="off">
      <div class="formactions">
        <button class="btn ghost" data-no>Cancelar</button>
        <button class="btn ${perigo ? 'danger' : 'primary'}" data-yes>${esc(ok)}</button>
      </div>`);
    const inp = host.querySelector('[data-inp]');
    const fim = v => { document.removeEventListener('keydown', onKey); fecharSheet(host); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') fim(null); };
    host.querySelector('[data-yes]').addEventListener('click', () => fim(inp.value));
    host.querySelector('[data-no]').addEventListener('click', () => fim(null));
    host.addEventListener('click', e => { if (e.target === host) fim(null); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fim(inp.value); } });
    document.addEventListener('keydown', onKey);
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
  });
}

/* =================================================================
   COLAR DO META — o maior ganho de fricção do produto.
   O Gerenciador copia células separadas por TAB. O cabeçalho muda de
   conta para conta e de idioma para idioma, então o mapa de colunas é
   sugerido pelo app e corrigido pelo dono. Nada é salvo sem revisão.
================================================================= */
const normHead = s => String(s).toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/* `k` é o id do input (dia) ou a coluna do banco (anúncio).
   `rot` cabe num <select> de 148px a 16px — abaixo disso o iPhone dá zoom. */
const CAMPOS_DIA = [
  { k: 'f_gasto', rot: 'Gasto', tipo: 'dec', syn: ['valor usado', 'valor gasto', 'amount spent', 'gasto', 'investimento'] },
  { k: 'f_faturado', rot: 'Faturado', tipo: 'dec', syn: ['valor de conversao da compra', 'valor de conversao de compras', 'purchase conversion value', 'valor de conversao', 'faturamento', 'receita'] },
  { k: 'f_compra', rot: 'Compras', tipo: 'int', syn: ['compras', 'purchases', 'resultados', 'results'] },
  { k: 'f_cliques', rot: 'Cliques', tipo: 'int', syn: ['cliques no link', 'link clicks', 'cliques'] },
  { k: 'f_visualizacao', rot: 'Vis. página', tipo: 'int', syn: ['visualizacoes da pagina de destino', 'landing page views', 'visualizacoes de pagina'] },
  { k: 'f_finalizacao', rot: 'Checkouts', tipo: 'int', syn: ['finalizacoes de compra iniciadas', 'finalizacao de compra iniciada', 'checkouts initiated', 'initiate checkout', 'checkout iniciado'] },
  { k: 'f_iniciadas', rot: 'Vendas inic.', tipo: 'int', syn: ['vendas iniciadas'] },
  { k: 'f_cpm', rot: 'CPM', tipo: 'dec', syn: ['cpm'] },
  { k: 'f_cpc', rot: 'CPC', tipo: 'dec', syn: ['cpc'] },
];
const CAMPOS_AD = [
  { k: 'anuncio', rot: 'Anúncio', tipo: 'txt', syn: ['nome do anuncio', 'ad name', 'anuncio', 'criativo'] },
  { k: 'gasto', rot: 'Gasto', tipo: 'dec', syn: ['valor usado', 'valor gasto', 'amount spent', 'gasto'] },
  { k: 'faturado', rot: 'Faturado', tipo: 'dec', syn: ['valor de conversao da compra', 'purchase conversion value', 'valor de conversao', 'faturamento'] },
  { k: 'compras', rot: 'Compras', tipo: 'int', syn: ['compras', 'purchases', 'resultados', 'results'] },
  { k: 'cliques', rot: 'Cliques', tipo: 'int', syn: ['cliques no link', 'link clicks', 'cliques'] },
  { k: 'cpm', rot: 'CPM', tipo: 'dec', syn: ['cpm'] },
  { k: 'cpc', rot: 'CPC', tipo: 'dec', syn: ['cpc'] },
  { k: 'ctr', rot: 'CTR (%)', tipo: 'dec', syn: ['ctr taxa de cliques no link', 'ctr', 'taxa de cliques'] },
  { k: 'custo_por_compra', rot: 'Custo/compra', tipo: 'dec', syn: ['custo por compra', 'custo por resultado', 'cost per purchase'] },
  { k: 'frequencia', rot: 'Frequência', tipo: 'dec', syn: ['frequencia', 'frequency'] },
  { k: 'hook_rate', rot: 'Hook rate', tipo: 'dec', syn: ['hook rate'] },
  { k: 'retencao_video', rot: 'Retenção', tipo: 'dec', syn: ['retencao de video', 'retencao'] },
];
const campoDe = (campos, k) => campos.find(c => c.k === k);

/** TAB é o separador do Gerenciador. Vírgula não entra: é o decimal pt-BR. */
function parseGrade(txt) {
  const linhas = txt.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (!linhas.length) return [];
  const sep = linhas[0].includes('\t') ? '\t' : linhas[0].includes(';') ? ';' : null;
  const grade = linhas.map(l => (sep ? l.split(sep) : [l]).map(c => c.trim()));
  const largura = Math.max(...grade.map(l => l.length));
  return grade.map(l => Array.from({ length: largura }, (_, i) => l[i] ?? ''));
}

/**
 * Duas passadas: na primeira só casamentos EXATOS. Sem isso a coluna
 * "Cliques (todos)" rouba o destino de "Cliques no link" só por vir antes.
 */
function mapearColunas(heads, campos) {
  const nota = heads.map(normHead);
  const mapa = new Array(heads.length).fill(null);
  const usados = new Set();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < nota.length; i++) {
      if (mapa[i] || !nota[i]) continue;
      let melhor = null, score = 0;
      for (const c of campos) {
        if (usados.has(c.k)) continue;
        for (const s of c.syn) {
          let sc = 0;
          if (nota[i] === s) sc = 100 + s.length;
          else if (pass === 1 && nota[i].startsWith(s)) sc = 50 + s.length;
          else if (pass === 1 && s.length >= 5 && nota[i].includes(s)) sc = 20 + s.length;
          if (sc > score) { score = sc; melhor = c.k; }
        }
      }
      if (melhor) { mapa[i] = melhor; usados.add(melhor); }
    }
  }
  return mapa;
}
/** cabeçalho = tem texto não-numérico e casa ao menos duas colunas conhecidas */
function ehCabecalho(linha, campos) {
  if (!linha.some(c => c.trim() && parseNum(c) === null)) return false;
  return mapearColunas(linha, campos).filter(Boolean).length >= 2;
}

function abrirColar(tipo) {
  const dia = tipo === 'dia';
  const campos = dia ? CAMPOS_DIA : CAMPOS_AD;
  let heads = [], linhas = [], mapa = [];

  const host = abrirSheet(`
    <h3>${dia ? 'Colar do Gerenciador' : 'Colar criativos do Gerenciador'}</h3>
    <p>No Gerenciador de Anúncios selecione a linha de cabeçalho e as linhas de dados, copie e cole aqui. O Ergosphere descobre as colunas — confira antes de ${dia ? 'preencher' : 'lançar'}.
${dia ? 'A data não vem do Gerenciador: ela continua sendo a do formulário.' : ''}</p>
    ${dia ? '' : `<label class="mrow wide">Data dos lançamentos <input type="date" id="colarData" value="${esc($('a_data').value || ontemISO())}"></label>`}
    <textarea id="colarTxt" rows="4" spellcheck="false" autocapitalize="off"
      placeholder="Cole aqui: uma linha de cabeçalho e ${dia ? 'a linha do total' : 'uma linha por criativo'}."></textarea>
    <div id="colarMap"></div>
    <div id="colarPrev"></div>
    <div class="formactions">
      <button class="btn ghost" data-no>Cancelar</button>
      <button class="btn primary" data-yes disabled>${dia ? 'Preencher o formulário' : 'Lançar criativos'}</button>
    </div>`, true);

  const btnOk = host.querySelector('[data-yes]');
  const fim = () => { document.removeEventListener('keydown', onKey); fecharSheet(host); };
  const onKey = e => { if (e.key === 'Escape' && noTopo(host)) fim(); };
  host.querySelector('[data-no]').addEventListener('click', fim);
  host.addEventListener('click', e => { if (e.target === host) fim(); });
  document.addEventListener('keydown', onKey);

  /* ---- leitura do texto colado ---- */
  function analisar() {
    const g = parseGrade($('colarTxt').value);
    if (!g.length) { heads = []; linhas = []; mapa = []; }
    else {
      const comHead = ehCabecalho(g[0], campos);
      heads = comHead ? g[0] : g[0].map((_, i) => `Coluna ${i + 1}`);
      linhas = comHead ? g.slice(1) : g;
      mapa = comHead ? mapearColunas(g[0], campos) : new Array(heads.length).fill(null);
    }
    renderMapa();
    renderPrev();
  }

  function renderMapa() {
    const alvo = $('colarMap');
    if (!heads.length) { alvo.innerHTML = ''; return; }
    alvo.innerHTML = `<div class="colarmap">${heads.map((h, i) => `
      <label title="${esc(h)}">
        <span>${esc(h) || '—'}</span>
        <select data-col="${i}">
          <option value="">— ignorar —</option>
          ${campos.map(c => `<option value="${c.k}"${mapa[i] === c.k ? ' selected' : ''}>${c.rot}</option>`).join('')}
        </select>
      </label>`).join('')}</div>`;

    alvo.querySelectorAll('select').forEach(sel => sel.addEventListener('change', () => {
      const i = Number(sel.dataset.col);
      /* um destino recebe uma coluna só: libera quem já o tinha */
      if (sel.value) mapa.forEach((v, j) => {
        if (j !== i && v === sel.value) {
          mapa[j] = null;
          const outro = alvo.querySelector(`select[data-col="${j}"]`);
          if (outro) outro.value = '';
        }
      });
      mapa[i] = sel.value || null;
      renderPrev();
    }));
  }

  /** valores de uma linha, já convertidos, ignorando célula vazia ou ilegível */
  function valoresDe(linha) {
    const out = {};
    mapa.forEach((k, i) => {
      if (!k) return;
      const cel = (linha[i] ?? '').trim();
      if (!cel) return;
      const campo = campoDe(campos, k);
      if (campo.tipo === 'txt') { out[k] = cel; return; }
      const n = campo.tipo === 'int' ? parseInt0(cel) : parseNum(cel);
      if (n != null) out[k] = campo.tipo === 'dec' ? Number(n.toFixed(4)) : n;
    });
    return out;
  }
  /* linhas de total do Gerenciador não são criativos */
  const ehTotal = nome => /^(total|resultados?\s+tota)/i.test(nome.trim());

  function renderPrev() {
    const alvo = $('colarPrev');
    if (!linhas.length || !mapa.some(Boolean)) {
      alvo.innerHTML = heads.length ? `<p class="colarerr">Escolha ao menos uma coluna de destino.</p>` : '';
      btnOk.disabled = true;
      return;
    }

    if (dia) {
      const vals = valoresDe(linhas[0]);
      const chaves = Object.keys(vals);
      btnOk.disabled = !chaves.length;
      alvo.innerHTML = !chaves.length
        ? `<p class="colarerr">Nenhum número reconhecido nesta linha.</p>`
        : `<p class="colarok">Vai preencher ${chaves.length} ${chaves.length === 1 ? 'campo' : 'campos'}${linhas.length > 1 ? ` — usando só a 1ª das ${linhas.length} linhas de dados` : ''}:</p>
           <ul class="colarlist">${chaves.map(k => `<li><span>${campoDe(campos, k).rot}</span><b>${campoDe(campos, k).tipo === 'dec' ? fmtDec(vals[k]) : fmtNum(vals[k])}</b></li>`).join('')}</ul>`;
      return;
    }

    if (!mapa.includes('anuncio')) {
      alvo.innerHTML = `<p class="colarerr">Escolha qual coluna traz o <b>nome do anúncio</b>.</p>`;
      btnOk.disabled = true;
      return;
    }
    const recs = registros();
    btnOk.disabled = !recs.length;
    alvo.innerHTML = !recs.length
      ? `<p class="colarerr">Nenhuma linha com nome de anúncio.</p>`
      : `<p class="colarok">${recs.length} ${recs.length === 1 ? 'criativo' : 'criativos'} em ${fmtData($('colarData').value)}:</p>
         <ul class="colarlist">${recs.map(r => `<li><span>${esc(r.anuncio)}</span><b>${r.gasto != null ? fmtBRL(r.gasto) : '—'}</b></li>`).join('')}</ul>`;
  }

  /** todos os registros com o MESMO conjunto de chaves: o PostgREST exige.
      `status` fica de fora de propósito: no insert o default do banco é
      'ativo', e num criativo que já existe pausado o upsert não o reativa. */
  function registros() {
    const dataISO = $('colarData').value;
    const chaves = [...new Set(mapa.filter(Boolean))].filter(k => k !== 'anuncio');
    const porNome = new Map();   // linha repetida no mesmo dia quebraria o ON CONFLICT
    for (const linha of linhas) {
      const vals = valoresDe(linha);
      if (!vals.anuncio || ehTotal(vals.anuncio)) continue;
      const rec = { data: dataISO, anuncio: vals.anuncio, campanha: projeto, user_id: uid };
      for (const k of chaves) rec[k] = vals[k] ?? null;
      porNome.set(rec.anuncio, rec);
    }
    return [...porNome.values()];
  }

  /* ---- aplicar ---- */
  btnOk.addEventListener('click', async () => {
    if (dia) {
      const vals = valoresDe(linhas[0]);
      for (const [k, v] of Object.entries(vals)) {
        /* "80,10" e não "80,1": sem agrupamento de milhar, que o parseNum
           reingere, mas com os centavos que o Gerenciador mostrou */
        $(k).value = campoDe(campos, k).tipo === 'dec' ? v.toFixed(2).replace('.', ',') : String(v);
      }
      updatePreviewsGeral();
      fim();
      $('formCardGeral').open = true;
      $('f_data').focus();
      toast(`${Object.keys(vals).length} campos preenchidos — confira a data e salve ✓`);
      return;
    }

    const dataISO = $('colarData').value;
    if (!dataISO) return toast('Escolha a data dos lançamentos.', true);
    const recs = registros();
    if (!recs.length) return toast('Nenhuma linha com nome de anúncio.', true);

    const dups = recs.filter(r => adRows.some(a => a.data === dataISO && a.anuncio === r.anuncio));
    if (dups.length && !await confirmar({
      titulo: `Sobrescrever ${dups.length} ${dups.length === 1 ? 'criativo' : 'criativos'}?`,
      texto: `${dups.map(d => d.anuncio).join(', ')} já ${dups.length === 1 ? 'tem lançamento' : 'têm lançamento'} em ${fmtData(dataISO)}.`,
      ok: 'Sobrescrever',
    })) return;

    btnOk.disabled = true;
    const { error } = await db.from('ads_anuncios_diarios').upsert(recs, { onConflict: 'user_id,data,anuncio,campanha' });
    btnOk.disabled = false;
    if (error) return toast('Erro ao lançar: ' + error.message, true);
    fim();
    toast(`${recs.length} ${recs.length === 1 ? 'criativo lançado' : 'criativos lançados'} em ${fmtData(dataISO)} ✓`);
    await loadData();
  });

  let t;
  $('colarTxt').addEventListener('input', () => { clearTimeout(t); t = setTimeout(analisar, 120); });
  if (!dia) $('colarData').addEventListener('change', renderPrev);
}

/* =================================================================
   META DO DIA — a única meta acionável com ~2 vendas/dia.
   Não é ROAS: é "faltam N vendas pro azul".

   lucro = compras·ticket·(1−d) − gasto − cpv·compras
   no equilíbrio (lucro = 0):   compras = gasto / (ticket·(1−d) − cpv)
   na margem alvo m:            compras = gasto / (ticket·(1−d)·(1−m) − cpv)
   O denominador é a CONTRIBUIÇÃO de cada venda.
================================================================= */
function ticketBrutoProjeto() {
  let fat = 0, comp = 0;
  for (const r of rows) { fat += num(r.faturado); comp += num(r.compra); }
  if (comp === 0) for (const r of adRows) { fat += num(r.faturado); comp += num(r.compras); }
  return comp > 0 ? fat / comp : null;
}
function gastoMedioDiario() {
  const comGasto = rows.filter(r => r.gasto != null);
  if (!comGasto.length) return null;
  return comGasto.reduce((s, r) => s + num(r.gasto), 0) / comGasto.length;
}
function metaDoDia() {
  const ticket = ticketBrutoProjeto();
  if (ticket == null || ticket <= 0) return null;

  const hoje = rows.find(r => r.data === todayISO());
  const gasto = hoje?.gasto != null ? Number(hoje.gasto) : gastoMedioDiario();
  if (gasto == null || gasto <= 0) return null;

  const d = dedPct() / 100;
  const cpv = num(eco.custo_por_venda);
  const m = num(eco.margem_alvo_pct) / 100;

  const contribBE = ticket * (1 - d) - cpv;
  const contribAlvo = ticket * (1 - d) * (1 - m) - cpv;
  if (contribBE <= 0) return { impossivel: true, ticket };

  const comprasBE = gasto / contribBE;
  const comprasAlvo = contribAlvo > 0 ? gasto / contribAlvo : null;

  const feitoFat = num(hoje?.faturado);
  const feitoComp = num(hoje?.compra);
  const faltaFat = Math.max(0, comprasBE * ticket - feitoFat);
  const faltaComp = Math.max(0, comprasBE - feitoComp);

  return {
    ticket, gasto, lancado: !!hoje,
    comprasBE, comprasAlvo,
    fatBE: comprasBE * ticket,
    fatAlvo: comprasAlvo != null ? comprasAlvo * ticket : null,
    feitoFat, feitoComp, faltaFat, faltaComp,
    progresso: comprasBE > 0 ? Math.min(1, feitoComp / comprasBE) : 0,
    pago: feitoComp >= comprasBE && feitoComp > 0,
  };
}

/* =================================================================
   ONDA 2 — o painel que decide.
   Três leituras que o painel antigo não tinha:
   para onde o dinheiro vai (cascata), o que está puxando a conta
   (forças de maré) e quanto fôlego ainda existe (aprendizado, reserva).
================================================================= */

/** os últimos `n` dias de CALENDÁRIO — não os `n` últimos lançamentos */
function ultimosDias(list, n) {
  const corte = isoAdd(todayISO(), -(n - 1));
  return list.filter(r => r.data >= corte);
}
/** ritmo de queima de agora: média dos até 7 últimos dias com gasto lançado */
function gastoMedioRecente() {
  const comGasto = rows.filter(r => r.gasto != null).slice(-7);
  if (!comGasto.length) return null;
  return comGasto.reduce((s, r) => s + num(r.gasto), 0) / comGasto.length;
}

/* -----------------------------------------------------------------
   CASCATA RECEITA → LUCRO
   Só soma os dias em que lucroOf() existe: a cascata TEM que fechar.
   Se sobrar diferença (o dia trouxe `faturamento_liquido` digitado à
   mão), ela vira um degrau "Ajuste" visível em vez de sumir na conta.
----------------------------------------------------------------- */
function cascata(list) {
  const d = dedPct() / 100;
  const cpv = num(eco.custo_por_venda);
  const c = { dias: 0, bruto: 0, ded: 0, reemb: 0, charge: 0, ajuste: 0, liq: 0, gasto: 0, custo: 0, desp: 0, lucro: 0 };
  for (const r of list) {
    const lucro = lucroOf(r);
    if (lucro == null) continue;
    const bruto = num(r.faturado);
    const liq = liquidoOf(r);
    const reemb = num(r.vendas_reembolsadas);
    const charge = num(r.vendas_chargeback);
    c.dias++;
    c.bruto += bruto;
    c.ded += bruto * d;
    c.reemb += reemb;
    c.charge += charge;
    c.ajuste += liq - (bruto * (1 - d) - reemb - charge);
    c.liq += liq;
    c.gasto += num(r.gasto);
    c.custo += cpv * num(r.compra);
    c.desp += num(r.despesas_adicionais);
    c.lucro += lucro;
  }
  return c.dias ? c : null;
}

function renderCascata() {
  const box = $('boxCascata');
  if (!box) return;
  const c = cascata(filterByPeriod(rows));

  if (!c) {
    destroyChart('chCascata');
    box.classList.add('chartwait');
    box.innerHTML = `<div class="accretion sm" style="opacity:.32"></div>
      <span>Lance um dia com gasto e faturamento<br>para ver por onde o dinheiro escapa.</span>`;
    $('cascataFoot').textContent = '';
    return;
  }
  restaurarCanvas('boxCascata', 'chCascata');

  const passos = [
    { l: 'Bruto', v: c.bruto, total: true },
    { l: 'Taxa + imposto', v: -c.ded },
    { l: 'Reembolsos', v: -c.reemb },
    { l: 'Chargeback', v: -c.charge },
    { l: 'Ajuste', v: c.ajuste },
    { l: 'Líquido', v: c.liq, total: true },
    { l: 'Mídia', v: -c.gasto },
    { l: 'Custo/venda', v: -c.custo },
    { l: 'Despesas', v: -c.desp },
    { l: 'Lucro', v: c.lucro, total: true, fim: true },
  ].filter(p => p.total || Math.abs(p.v) >= 0.005);

  /* barras flutuantes: cada degrau parte de onde o anterior terminou */
  let cur = 0;
  const data = [], cores = [];
  for (const p of passos) {
    if (p.total) { data.push([0, p.v]); cur = p.v; }
    else { data.push([cur, cur + p.v]); cur += p.v; }
    cores.push(
      p.fim ? (p.v >= 0 ? C.good : C.bad) :
      p.total ? SERIES[0] :
      p.v >= 0 ? SERIES[1] : 'rgba(230, 103, 103, 0.72)');
  }

  makeChart('chCascata', {
    type: 'bar',
    data: { labels: passos.map(p => p.l), datasets: [{ label: 'Etapa', data, backgroundColor: cores, borderRadius: 3, borderSkipped: false, maxBarThickness: 22, categoryPercentage: 0.78, barPercentage: 0.92 }] },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 84 } },
      plugins: {
        legend: { display: false },
        endlabels: { kind: 'cascata' },
        tooltip: {
          backgroundColor: C.card2, borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1,
          titleColor: C.text, bodyColor: C.text2, padding: 10, cornerRadius: 8, displayColors: false,
          callbacks: {
            label: ctx => {
              const p = passos[ctx.dataIndex];
              const sinal = p.total ? '=' : (p.v >= 0 ? '+' : '−');
              const share = c.bruto > 0 ? ` · ${nf0.format((Math.abs(p.v) / c.bruto) * 100)}% do bruto` : '';
              return ` ${sinal} ${fmtBRL(Math.abs(p.v))}${share}`;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true, border: { display: false },
          grid: { color: ctx => ctx.tick.value === 0 ? C.zero : C.grid },
          ticks: { maxTicksLimit: 5, callback: v => 'R$ ' + nf0.format(v) },
        },
        y: { grid: { display: false }, border: { display: false }, ticks: { color: C.text2, font: { weight: '600' } } },
      },
    },
  });

  const sobra = c.bruto > 0 ? (c.lucro / c.bruto) * 100 : null;
  /* no vermelho, "de cada R$ 100 chegam −41,82" não é frase — é um sinal de menos solto */
  const frase = sobra == null ? ''
    : sobra >= 0
      ? `De cada R$ 100 faturados, <b class="up">${nf2.format(sobra)}</b> chegam ao seu bolso.`
      : `A cada R$ 100 faturados você ainda perde <b class="down">${nf2.format(Math.abs(sobra))}</b> do próprio bolso.`;
  $('cascataFoot').innerHTML = [
    `${c.dias} ${c.dias === 1 ? 'dia' : 'dias'} no período.`,
    frase,
    temEconomia() ? '' : 'Sem taxa e imposto configurados, a cascata só desconta o que você digitou.',
  ].filter(Boolean).join(' ');
}

/* -----------------------------------------------------------------
   MEDIDORES — bullet graph. Barra = dado (semântico).
   Marcador = limiar, e por isso é ouro. O contrato não muda aqui.
----------------------------------------------------------------- */
function medidor(valor, marca, teto, cls) {
  const esc = Math.max(teto, marca * 1.2, valor * 1.08) || 1;
  const pct = v => Math.max(0, Math.min(100, (v / esc) * 100));
  return `<div class="horizonbar">
    <div class="fill ${cls || ''}" style="width:${pct(valor).toFixed(1)}%"></div>
    <div class="mark" style="left:${pct(marca).toFixed(1)}%"></div>
  </div>`;
}

/** O Meta precisa de ~50 conversões em 7 dias para sair da fase de aprendizado. */
const META_APRENDIZADO = 50;
function aprendizado() {
  const semana = ultimosDias(rows, 7);
  if (!semana.length) return null;
  const conv = semana.reduce((s, r) => s + num(r.compra), 0);
  return { conv, dias: semana.length, pronto: conv >= META_APRENDIZADO };
}

/** Pista em dias: quanto a operação aguenta no ritmo atual sem dinheiro novo. */
const RESERVA_MIN = 7;
function reserva() {
  const gasto = gastoMedioRecente();
  if (gasto == null || gasto <= 0) return null;
  let acum = 0, tem = false;
  for (const r of rows) { const l = lucroOf(r); if (l != null) { acum += l; tem = true; } }
  if (!tem) return null;
  return { acum, gasto, dias: acum > 0 ? acum / gasto : 0 };
}

function renderGauges() {
  const box = $('hojeGauges');
  if (!box) return;
  const ap = aprendizado();
  const rs = reserva();
  const cards = [];

  if (ap) {
    const nivel = ap.pronto ? 'good' : 'warn';
    cards.push(`<div class="plate gauge">
      <div class="cardhead"><h3>Fase de aprendizado <span class="sub">· últimos 7 dias</span></h3></div>
      <div class="gaugenum ${nivel}">${nf0.format(ap.conv)}<small> / ${META_APRENDIZADO} conversões</small></div>
      ${medidor(ap.conv, META_APRENDIZADO, META_APRENDIZADO, ap.pronto ? '' : 'warn')}
      <p class="chartfoot">${ap.pronto
        ? 'O Meta tem sinal suficiente para otimizar sozinho. Mudanças de orçamento custam menos agora.'
        : `Abaixo de ${META_APRENDIZADO} conversões por semana o algoritmo não sai do aprendizado. Cada troca de orçamento reinicia a contagem — evite picotar verba entre criativos.`}
        ${ap.dias < 7 ? `<br>Só ${ap.dias} dos últimos 7 dias estão lançados.` : ''}</p>
    </div>`);
  }

  if (rs) {
    const dias = Math.floor(rs.dias);
    const nivel = rs.dias >= RESERVA_MIN ? 'good' : rs.dias > 0 ? 'warn' : 'bad';
    cards.push(`<div class="plate gauge">
      <div class="cardhead"><h3>Reserva de combustível <span class="sub">· a ${fmtBRL(rs.gasto)}/dia</span></h3></div>
      <div class="gaugenum ${nivel}">${rs.acum > 0
        ? `${nf0.format(dias)}<small> ${dias === 1 ? 'dia de pista' : 'dias de pista'}</small>`
        : 'Sem reserva'}</div>
      ${medidor(Math.max(0, rs.dias), RESERVA_MIN, 30, nivel === 'good' ? '' : nivel)}
      <p class="chartfoot">${rs.acum > 0
        ? `O lucro acumulado (${fmtBRL(rs.acum)}) banca ${nf0.format(dias)} ${dias === 1 ? 'dia' : 'dias'} no ritmo de gasto atual, sem colocar dinheiro novo. Abaixo de ${RESERVA_MIN} dias, um teste ruim quebra a operação.`
        : `A conta está ${fmtBRL(Math.abs(rs.acum))} no negativo acumulado. Todo real gasto hoje sai do seu bolso, não do que a operação devolveu.`}</p>
    </div>`);
  }

  box.innerHTML = cards.join('');
}

/* -----------------------------------------------------------------
   FORÇAS DE MARÉ — a central de alertas.
   Consolida o que antes estava espalhado em células amarelas de tabela
   e notas de rodapé. Cada força tem severidade e um próximo passo.
----------------------------------------------------------------- */
const SEVS = { alta: 0, media: 1, baixa: 2 };
const MAX_MARES = 5;

function mares() {
  const av = [];
  const ultimo = rows[rows.length - 1];

  if (!temEconomia()) av.push({
    sev: 'alta', t: 'Economia do projeto zerada',
    p: 'Sem a taxa do gateway e o imposto, o lucro é estimado no bruto e o horizonte de eventos fica travado em ROAS 1,00.',
    acao: 'economia', btn: 'Configurar',
  });

  if (ultimo) {
    const atraso = isoDiffDias(ultimo.data, todayISO());
    if (atraso >= 2) av.push({
      sev: atraso >= 4 ? 'alta' : 'media',
      t: `Sem lançamento há ${atraso} dias`,
      p: `O último dia lançado é ${fmtData(ultimo.data)}. Toda leitura desta tela está velha.`,
      acao: 'lancar-dia', btn: 'Lançar',
    });
  }

  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) { const l = lucroOf(rows[i]); if (l != null && l < 0) streak++; else break; }
  if (streak >= 3) av.push({
    sev: streak >= 5 ? 'alta' : 'media',
    t: `${streak} dias seguidos no vermelho`,
    p: 'Já não é ruído, é tendência. Corte o criativo mais caro antes de mexer no orçamento da campanha.',
    acao: 'anuncios', btn: 'Ver ranking',
  });

  /* pico de leilão: o último dia contra a média dos até 7 anteriores */
  for (const m of [
    { f: cpcOf, n: 'CPC', d: 'O clique está mais caro: leilão aquecido ou criativo cansado.' },
    { f: r => r.cpm, n: 'CPM', d: 'Mil impressões custam mais. O leilão subiu, e isso não é culpa do seu anúncio.' },
  ]) {
    const i = rows.length - 1;
    if (i < 2) break;
    const atual = m.f(rows[i]);
    const antes = rows.slice(Math.max(0, i - 7), i).map(m.f).filter(v => v != null);
    if (atual == null || antes.length < 2) continue;
    const media = avg(antes);
    if (media > 0 && atual > media * (1 + settings.spikePct / 100)) av.push({
      sev: 'media',
      t: `${m.n} ${nf0.format(((atual / media) - 1) * 100)}% acima da média`,
      p: `${fmtBRL(atual)} em ${fmtData(rows[i].data)} contra ${fmtBRL(media)} de média dos dias anteriores. ${m.d}`,
    });
  }

  const perda = ultimo ? perdaOf(ultimo) : null;
  if (perda != null && perda > settings.perdaMax) av.push({
    sev: 'media',
    t: `Perda de tráfego de ${fmtPct(perda)}`,
    p: `De cada 100 cliques, ${nf0.format(perda)} não chegam a ver a página. É página lenta, link errado ou clique acidental — e você paga por todos.`,
  });

  const t7 = totais(ultimosDias(rows, 7));
  if (t7.aprov != null && t7.aprov < 80) av.push({
    sev: t7.aprov < 60 ? 'alta' : 'media',
    t: `${fmtPct(t7.aprov)} de aprovação no checkout`,
    p: 'O vazamento está no gateway, não no anúncio: pix não pago, boleto vencido, cartão recusado.',
  });

  const fadiga = adNames().map(n => {
    const dias = ultimosDias(adRows.filter(a => a.anuncio === n), 7).filter(a => a.frequencia != null);
    return dias.length ? { n, f: Number(dias[dias.length - 1].frequencia) } : null;
  }).filter(x => x && x.f >= 2.5);
  if (fadiga.length) av.push({
    sev: 'media',
    t: `${fadiga.length} ${fadiga.length === 1 ? 'criativo saturado' : 'criativos saturados'}`,
    p: `${fadiga.map(x => `${x.n} (frequência ${fmtDec(x.f)})`).join(', ')} — o mesmo público já viu demais. Troque o criativo antes que o custo por compra suba.`,
    acao: 'anuncios', btn: 'Ver ranking',
  });

  /* um só criativo pedindo corte já aparece em "Próxima ação"; a partir de dois vira maré */
  const cortar = adNames().map(n => {
    const dias = adRows.filter(r => r.anuncio === n).sort((a, b) => a.data.localeCompare(b.data));
    return dias.length ? { n, v: diagnose(dias).verdict } : null;
  }).filter(x => x && x.v === 'Cortar');
  if (cortar.length >= 2) av.push({
    sev: 'alta',
    t: `${cortar.length} criativos pedindo corte`,
    p: `${cortar.map(x => x.n).join(', ')} — todos já gastaram além do custo por compra alvo sem devolver.`,
    acao: 'anuncios', btn: 'Ver ranking',
  });

  const rs = reserva();
  if (rs && rs.acum > 0 && rs.dias < RESERVA_MIN) av.push({
    sev: 'media',
    t: `Reserva para ${nf0.format(Math.floor(rs.dias))} ${Math.floor(rs.dias) === 1 ? 'dia' : 'dias'}`,
    p: `No ritmo de ${fmtBRL(rs.gasto)} por dia, o lucro acumulado acaba antes de uma semana. Um teste ruim custa caro agora.`,
  });

  return av.sort((a, b) => SEVS[a.sev] - SEVS[b.sev]);
}

function renderMares() {
  const box = $('hojeMares');
  if (!box) return;
  const av = mares();

  if (!av.length) {
    box.innerHTML = `<div class="plate">
      <div class="cardhead"><h3>Forças de maré <span class="sub">· o que puxa a conta</span></h3></div>
      <p class="chartfoot" style="margin:0">Nenhuma força de maré detectada. Nada aqui exige a sua mão agora.</p>
    </div>`;
    return;
  }

  const vis = av.slice(0, MAX_MARES);
  const resto = av.length - vis.length;
  box.innerHTML = `<div class="plate">
    <div class="cardhead"><h3>Forças de maré <span class="sub">· ${av.length} ${av.length === 1 ? 'alerta' : 'alertas'}</span></h3></div>
    <ul class="tides">${vis.map(a => `<li class="${a.sev}">
      <div class="tidebody">
        <div class="tidet">${esc(a.t)}</div>
        <div class="tidep">${esc(a.p)}</div>
      </div>
      ${a.acao ? `<button class="rowbtn txt" data-acao="${a.acao}">${esc(a.btn)}</button>` : ''}
    </li>`).join('')}</ul>
    ${resto > 0 ? `<p class="chartfoot">+${resto} ${resto === 1 ? 'alerta de menor severidade' : 'alertas de menor severidade'}.</p>` : ''}
  </div>`;
  ligarAcoes(box);
}

/* =================================================================
   TELA HOJE — "o que eu faço agora"
================================================================= */
function saudacao() {
  const h = new Date().getHours();
  if (h < 5) return 'Boa madrugada';
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}
function renderHoje() {
  const hojeISO = todayISO();
  const ontem = ontemISO();
  const rHoje = rows.find(r => r.data === hojeISO);
  const rOntem = rows.find(r => r.data === ontem);

  $('hojeOi').textContent = saudacao();
  $('hojeData').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

  /* nenhum lançamento: o app inteiro é um estado-vazio. É aqui que o luxo se paga. */
  if (!rows.length) {
    $('hojePendencia').innerHTML = '';
    $('hojeHero').innerHTML = `<div class="plate herocall">
      <div class="accretion lg"></div>
      <h2>Nada em órbita ainda</h2>
      <p>${temEconomia()
        ? 'Lance o primeiro dia e o Ergosphere começa a medir onde está o seu horizonte de eventos.'
        : 'Comece pela economia do projeto — é ela que separa faturamento de lucro real.'}</p>
      <button class="btn primary" data-acao="${temEconomia() ? 'lancar-dia' : 'economia'}">
        ${temEconomia() ? 'Lançar o primeiro dia' : 'Configurar a economia'}
      </button>
    </div>`;
    $('hojeMeta').innerHTML = '';
    /* renderVeredito deixa a classe .diag no elemento; sem limpar, sobra uma
       moldura vazia flutuando abaixo do herói */
    $('hojeVeredito').className = '';
    $('hojeVeredito').innerHTML = '';
    $('hojeMares').innerHTML = '';
    $('hojeGauges').innerHTML = '';
    $('hojeAcao').innerHTML = '';
    $('hojeStreakCard').classList.add('hidden');
    ligarAcoes($('hojeHero'));
    return;
  }
  $('hojeStreakCard').classList.remove('hidden');

  /* banner de pendência */
  $('hojePendencia').innerHTML = rHoje ? '' : `<div class="pendencia">
    <p>Você ainda não lançou hoje.</p>
    <button class="btn primary small" data-acao="lancar-dia">Lançar hoje</button>
  </div>`;

  /* herói: quanto entrou e saiu HOJE. Nível dia = só "quanto". */
  if (rHoje) {
    const t = totais([rHoje]);
    $('hojeHero').innerHTML = `<div class="plate">
      <div class="cardhead"><h3>Hoje <span class="sub">· ${fmtData(hojeISO)}</span></h3></div>
      <div class="hoje-num">
        ${kpiCard('Lucro', fmtBRL(t.lucro), '<div class="kdelta">do dia</div>', t.lucro >= 0 ? 'good' : 'bad')}
        ${kpiCard('Gasto', fmtBRL(t.gasto), '<div class="kdelta">investido</div>')}
        ${kpiCard('Compras', fmtNum(t.compra), '<div class="kdelta">vendas aprovadas</div>')}
      </div>
    </div>`;
  } else if (rOntem) {
    const t = totais([rOntem]);
    $('hojeHero').innerHTML = `<div class="plate">
      <div class="cardhead"><h3>Ontem <span class="sub">· ${fmtData(ontem)}</span></h3></div>
      <div class="hoje-num">
        ${kpiCard('Lucro', fmtBRL(t.lucro), '<div class="kdelta">do dia</div>', t.lucro >= 0 ? 'good' : 'bad')}
        ${kpiCard('Gasto', fmtBRL(t.gasto), '<div class="kdelta">investido</div>')}
        ${kpiCard('Compras', fmtNum(t.compra), '<div class="kdelta">vendas aprovadas</div>')}
      </div>
    </div>`;
  } else {
    $('hojeHero').innerHTML = '';
  }

  /* meta do dia */
  const meta = metaDoDia();
  if (!meta) {
    $('hojeMeta').innerHTML = `<div class="plate">
      <div class="cardhead"><h3>Velocidade de escape</h3></div>
      <p class="chartfoot" style="margin:0">Depois da primeira venda o Ergosphere calcula quanto falta,
      em reais e em número de vendas, para o dia fechar no azul.</p>
    </div>`;
  } else if (meta.impossivel) {
    $('hojeMeta').innerHTML = `<div class="plate">
      <div class="cardhead"><h3>Velocidade de escape</h3></div>
      <p class="chartfoot" style="margin:0">Cada venda de ${fmtBRL(meta.ticket)} não cobre nem as deduções
      e o custo por venda. Nenhum volume fecha a conta — revise a oferta ou a economia do projeto.</p>
    </div>`;
  } else {
    const faltaTxt = meta.pago
      ? `<div class="metanum good">Dia pago</div><div class="metasub">o gasto de hoje já voltou</div>`
      : `<div class="metanum">${fmtBRL(meta.faltaFat)}</div>
         <div class="metasub">≈ ${meta.faltaComp < 1 ? 'menos de 1 venda' : `${nf0.format(Math.ceil(meta.faltaComp))} ${Math.ceil(meta.faltaComp) === 1 ? 'venda' : 'vendas'}`} para o azul</div>`;
    $('hojeMeta').innerHTML = `<div class="plate">
      <div class="cardhead"><h3>Velocidade de escape <span class="sub">· ${meta.lancado ? 'sobre o gasto de hoje' : 'estimado no gasto médio'}</span></h3></div>
      <div class="metabox">
        <div>
          <div class="metalbl">Falta para pagar o dia</div>
          ${faltaTxt}
        </div>
        <div>
          <div class="metalbl">Para bater a margem alvo</div>
          <div class="metanum">${meta.fatAlvo != null ? fmtBRL(meta.fatAlvo) : '—'}</div>
          <div class="metasub">${meta.comprasAlvo != null ? `≈ ${nf0.format(Math.ceil(meta.comprasAlvo))} vendas · ${nf0.format(num(eco.margem_alvo_pct))}% de margem` : 'defina a margem alvo em Conta'}</div>
        </div>
      </div>
      <div class="progress"><i style="width:${(meta.progresso * 100).toFixed(1)}%"></i></div>
      <p class="chartfoot">Gasto de referência ${fmtBRL(meta.gasto)} · ticket médio ${fmtBRL(meta.ticket)}${temEconomia() ? '' : ' · sem deduções configuradas'}</p>
    </div>`;
  }

  /* veredito do período (mesma leitura da Visão Geral, resumida) */
  renderVeredito($('hojeVeredito'));

  /* o que puxa a conta agora, e quanto fôlego ainda existe */
  renderMares();
  renderGauges();

  /* próxima ação: o criativo mais urgente segundo o diagnose() que já existe */
  $('hojeAcao').innerHTML = proximaAcaoHtml();
  ligarAcoes($('hojePendencia'));
  ligarAcoes($('hojeAcao'));

  /* órbitas registradas: 14 dias */
  const cel = [];
  for (let i = 13; i >= 0; i--) {
    const d = isoAdd(hojeISO, -i);
    const r = rows.find(x => x.data === d);
    const l = r ? lucroOf(r) : null;
    const cls = r == null ? '' : (l == null ? '' : (l >= 0 ? 'good' : 'bad'));
    cel.push(`<i class="${cls}${d === hojeISO ? ' hoje' : ''}" title="${fmtData(d)}${r ? ' · ' + fmtBRL(l) : ' · sem lançamento'}"></i>`);
  }
  $('hojeStreak').innerHTML = cel.join('');
  const lancados = cel.filter(c => c.includes('good') || c.includes('bad')).length;
  $('hojeStreakFoot').textContent = `${lancados} de 14 dias lançados. Cada dia lançado é uma órbita completa.`;
}

/** O criativo que mais pede uma decisão agora. Reusa diagnose(). */
function proximaAcaoHtml() {
  const nomes = adNames();
  if (!nomes.length) {
    return `<div class="plate">
      <div class="cardhead"><h3>Próxima ação</h3></div>
      <p class="chartfoot" style="margin:0 0 12px">Detalhe os criativos do dia para o Ergosphere dizer qual cortar e qual escalar.</p>
      <button class="btn ghost small" data-acao="lancar-anuncio">＋ Lançar anúncio</button>
    </div>`;
  }
  const PRIO = { 'Cortar': 0, 'Escalar': 1, 'Testar novo criativo': 2, 'Manter': 3, 'Coletando dados': 4 };
  const cands = nomes.map(n => {
    const days = adRows.filter(r => r.anuncio === n).sort((a, b) => a.data.localeCompare(b.data));
    if (!days.length) return null;
    const d = diagnose(days);
    return { nome: n, ...d };
  }).filter(Boolean).sort((a, b) => (PRIO[a.verdict] ?? 9) - (PRIO[b.verdict] ?? 9) || num(b.gasto) - num(a.gasto));

  const top = cands[0];
  const resumo = Object.entries(cands.reduce((acc, c) => { acc[c.verdict] = (acc[c.verdict] || 0) + 1; return acc; }, {}))
    .map(([v, n]) => `${n} ${v.toLowerCase()}`).join(' · ');

  return `<div class="diag ${top.vClass}">
    <div class="diaghead">
      <span class="verdict ${top.vClass}">${top.verdict}</span>
      <span class="vsum"><b>${esc(top.nome)}</b> — ${top.vSum}</span>
    </div>
    <p class="diagfoot">${resumo}. <button class="rowbtn txt" data-ana-hoje="${esc(top.nome)}">Analisar ${esc(top.nome)} →</button></p>
  </div>`;
}

/* =================================================================
   DIÁRIO DE BORDO — ação → efeito
================================================================= */
function renderDiario() {
  const itens = [];
  for (const r of rows) {
    if (!r.observacoes) continue;
    const l = lucroOf(r);
    itens.push({ data: r.data, txt: r.observacoes, tipo: 'dia', meta: 'dia inteiro', val: l, roas: roasOf(r) });
  }
  for (const a of adRows) {
    if (!a.observacoes) continue;
    itens.push({ data: a.data, txt: a.observacoes, tipo: 'ad', meta: a.anuncio, val: adLucroOf(a), roas: adRoasOf(a) });
  }
  itens.sort((x, y) => y.data.localeCompare(x.data));

  const feed = $('diarioFeed');
  const vazio = $('diarioEmpty');
  if (!itens.length) {
    feed.innerHTML = '';
    vazio.classList.remove('hidden');
    vazio.innerHTML = noSignal(
      'Nenhuma anotação ainda',
      'Toda vez que você trocar um criativo, mexer no orçamento ou mudar o público, escreva no campo Observações. Em 30 dias isso vira a memória do seu operador.',
      rows.length ? { acao: 'lancar-dia', txt: 'Lançar um dia com anotação' } : { acao: 'lancar-dia', txt: 'Lançar o primeiro dia' });
    ligarAcoes(vazio);
    return;
  }
  vazio.classList.add('hidden');
  feed.innerHTML = itens.map(i => `<div class="feeditem">
    <div class="feedmark">${i.tipo === 'dia' ? '◈' : '◉'}</div>
    <div class="feedbody">
      <div class="feedtxt">${esc(i.txt)}</div>
      <div class="feedmeta">${fmtData(i.data)} · ${esc(i.meta)}</div>
    </div>
    <div class="feedres ${i.val == null ? '' : (i.val >= 0 ? 'good' : 'bad')}">
      ${fmtBRL(i.val)}
      <small>${i.roas == null ? '' : 'ROAS ' + fmtDec(i.roas)}</small>
    </div>
  </div>`).join('');
}

/* =================================================================
   CONTA
================================================================= */
function renderConta() {
  $('acctMail').textContent = userEmail || '—';
  $('acctAvatar').textContent = (userEmail || '?').charAt(0).toUpperCase();
  const nAds = adNames().length;
  $('acctResumo').textContent =
    `${projetos.length} ${projetos.length === 1 ? 'projeto' : 'projetos'} · ${rows.length} ${rows.length === 1 ? 'dia' : 'dias'} · ${nAds} ${nAds === 1 ? 'criativo' : 'criativos'}`;

  $('ecoProjName').textContent = '· ' + projeto;
  $('projNomeAtual').textContent = projeto;
  $('s_taxa').value = numToInput(eco.taxa_pct);
  $('s_imposto').value = numToInput(eco.imposto_pct);
  $('s_custo').value = numToInput(eco.custo_por_venda);
  $('s_margem').value = numToInput(eco.margem_alvo_pct);
  $('s_perda').value = numToInput(settings.perdaMax);
  $('s_spike').value = numToInput(settings.spikePct);
  ecoPreviewText();
  $('btnDelProj').disabled = projetos.length < 2;
}

/* =================================================================
   Navegação
================================================================= */
const ABAS = [
  { id: 'hoje', label: 'Hoje', ico: '◐' },
  { id: 'geral', label: 'Geral', ico: '◈' },
  { id: 'anuncios', label: 'Anúncios', ico: '◉' },
  { id: 'diario', label: 'Diário', ico: '✎' },
  { id: 'conta', label: 'Conta', ico: '☾' },
];
let abaAtiva = localStorage.getItem('ergo_aba') || 'hoje';

function montarNav() {
  const btn = a => `<button class="navbtn" role="tab" id="nav-${a.id}" data-tab="${a.id}"
      aria-selected="false" aria-controls="tab-${a.id}"><span class="ico">${a.ico}</span><span>${a.label}</span></button>`;
  $('navTop').innerHTML = ABAS.map(btn).join('');
  $('navBottom').innerHTML = ABAS.map(btn).join('');
  document.querySelectorAll('.navbtn').forEach(b => b.addEventListener('click', () => trocarAba(b.dataset.tab)));
}

function trocarAba(nome) {
  if (!ABAS.some(a => a.id === nome)) nome = 'hoje';
  abaAtiva = nome;
  localStorage.setItem('ergo_aba', nome);
  document.querySelectorAll('.navbtn').forEach(x => {
    const on = x.dataset.tab === nome;
    x.classList.toggle('active', on);
    x.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  ABAS.forEach(a => $('tab-' + a.id)?.classList.toggle('hidden', a.id !== nome));
  $('projbar').classList.toggle('hidden', nome === 'conta');
  /* na Conta o FAB não tem o que fazer — e cobriria os campos da direita */
  $('fabLancar').classList.toggle('hidden', nome === 'conta');
  window.scrollTo({ top: 0, behavior: 'instant' });
  renderAll();
}

/* =================================================================
   Onboarding — "Primeira Órbita"
================================================================= */
const PASSOS = [
  {
    t: 'Ergosphere',
    p: 'A ergosfera é a casca de um buraco negro em rotação de onde ainda dá pra extrair energia e escapar com ela. É o que você faz com uma conta de anúncios.',
    b: 'Começar',
  },
  {
    t: 'Onde fica o seu horizonte',
    p: 'Sem a taxa do gateway e o imposto, o painel só sabe seu faturamento bruto — e chuta o lucro. Com eles, ele calcula o ROAS de equilíbrio: o horizonte de eventos, abaixo do qual nada volta.',
    b: 'Continuar',
  },
  {
    t: 'Um minuto, uma vez',
    p: 'Preencha a taxa do gateway, o imposto e o custo por venda. É a única coisa que o Ergosphere não consegue adivinhar — e é o que transforma faturamento em lucro real.',
    b: 'Configurar a economia',
    acao: 'economia',
  },
];
let passoAtual = 0;

function renderOnboard() {
  const p = PASSOS[passoAtual];
  $('onboard').innerHTML = `<div class="onbwrap">
    <div class="accretion lg" style="margin:0 auto"></div>
    <div class="onbdots">${PASSOS.map((_, i) => `<i class="${i <= passoAtual ? 'on' : ''}"></i>`).join('')}</div>
    <h2>${p.t}</h2>
    <p>${p.p}</p>
    <button class="btn primary block" id="onbNext">${p.b}</button>
    <button class="authswitch onbskip" id="onbSkip">Pular introdução</button>
  </div>`;
  $('onbNext').addEventListener('click', () => {
    const feito = PASSOS[passoAtual];
    passoAtual++;
    if (passoAtual >= PASSOS.length) {
      fecharOnboard();
      if (feito.acao) acao(feito.acao);
      return;
    }
    renderOnboard();
  });
  $('onbSkip').addEventListener('click', fecharOnboard);
}
function abrirOnboard() { passoAtual = 0; $('onboard').classList.remove('hidden'); renderOnboard(); }
function fecharOnboard() {
  $('onboard').classList.add('hidden');
  $('onboard').innerHTML = '';
  localStorage.setItem('ergo_onboard', '1');
}

/* =================================================================
   PWA
================================================================= */
let promptInstalar = null;
function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  /* o escopo no GitHub Pages é a subpasta do repo, não a raiz do domínio */
  const base = location.pathname.replace(/[^/]*$/, '');
  navigator.serviceWorker.register(base + 'sw.js', { scope: base }).catch(() => { /* offline é bônus */ });
}
function ligarInstalacao() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    promptInstalar = e;
    $('btnInstalar').disabled = false;
  });
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  if (standalone) {
    $('instalarTxt').textContent = 'O Ergosphere já está instalado neste aparelho.';
    $('btnInstalar').classList.add('hidden');
  } else if (ios) {
    $('instalarTxt').innerHTML = 'No iPhone: toque em <b>Compartilhar</b> e depois em <b>Adicionar à Tela de Início</b>.';
    $('btnInstalar').classList.add('hidden');
  } else {
    $('btnInstalar').disabled = true;
  }

  $('btnInstalar').addEventListener('click', async () => {
    if (!promptInstalar) return toast('Use o menu do navegador → Instalar aplicativo.', true);
    promptInstalar.prompt();
    await promptInstalar.userChoice;
    promptInstalar = null;
    $('btnInstalar').disabled = true;
  });
}

/* =================================================================
   Auth
================================================================= */
let modoCadastro = false;

function showLogin() {
  $('splash').classList.add('hidden');
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}
function erroLogin(msg) {
  $('loginErr').textContent = msg;
  $('loginErr').classList.remove('hidden');
}
function alternarModo() {
  modoCadastro = !modoCadastro;
  $('loginConvite').classList.toggle('hidden', !modoCadastro);
  $('loginPass').setAttribute('autocomplete', modoCadastro ? 'new-password' : 'current-password');
  $('loginBtn').textContent = modoCadastro ? 'Criar conta' : 'Entrar';
  $('btnAuthSwitch').textContent = modoCadastro ? 'Já tenho conta — entrar' : 'Tenho um convite — criar conta';
  $('authSub').textContent = modoCadastro
    ? 'Beta fechado. Use o código do seu convite.'
    : 'A zona onde ainda dá pra extrair energia.';
  $('loginErr').classList.add('hidden');
}

async function enterApp() {
  const { data: { user } } = await db.auth.getUser();
  if (!user) return showLogin();

  /* portão do beta: sem convite resgatado, não entra */
  const { data: ok, error } = await db.rpc('tenho_acesso');
  if (error) { erroLogin('Não consegui validar seu acesso: ' + error.message); await db.auth.signOut(); return showLogin(); }
  if (!ok) {
    await db.auth.signOut();
    showLogin();
    return erroLogin('Esta conta não tem convite ativo. Crie a conta com um código de convite.');
  }

  uid = user.id;
  userEmail = user.email || '';

  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  montarNav();
  await loadProjetos();
  await loadData();
  trocarAba(abaAtiva);
  $('splash').classList.add('hidden');

  if (!localStorage.getItem('ergo_onboard')) { abrirOnboard(); return; }

  /* atalhos do ícone na tela de início (manifest.shortcuts) */
  const atalho = new URLSearchParams(location.search).get('acao');
  if (atalho === 'lancar-dia' || atalho === 'lancar-anuncio') {
    history.replaceState(null, '', location.pathname);
    acao(atalho);
  }
}

async function submeterAuth(e) {
  e.preventDefault();
  const email = $('loginEmail').value.trim();
  const senha = $('loginPass').value;
  $('loginBtn').disabled = true;
  $('loginErr').classList.add('hidden');

  try {
    if (modoCadastro) {
      const codigo = $('loginConvite').value.trim();
      if (!codigo) throw new Error('Informe o código do convite.');

      const { error: e1 } = await db.auth.signUp({ email, password: senha });
      if (e1 && !/already registered/i.test(e1.message)) throw e1;

      /* se o projeto exigir confirmação de e-mail, não há sessão ainda */
      const { data: { session } } = await db.auth.getSession();
      if (!session) {
        const { error: e2 } = await db.auth.signInWithPassword({ email, password: senha });
        if (e2) throw new Error('Conta criada. Confirme o e-mail e depois entre.');
      }
      const { data: resg, error: e3 } = await db.rpc('resgatar_convite', { p_codigo: codigo });
      if (e3) throw e3;
      if (!resg) { await db.auth.signOut(); throw new Error('Código de convite inválido ou já usado.'); }
    } else {
      const { error } = await db.auth.signInWithPassword({ email, password: senha });
      if (error) throw new Error(/invalid login/i.test(error.message) ? 'E-mail ou senha incorretos.' : error.message);
    }
    await enterApp();
  } catch (err) {
    erroLogin(err.message || String(err));
  }
  $('loginBtn').disabled = false;
}

async function esqueciSenha() {
  const email = $('loginEmail').value.trim();
  if (!email) return erroLogin('Escreva seu e-mail primeiro.');
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.href });
  if (error) return erroLogin(error.message);
  toast('Enviamos um link de redefinição para o seu e-mail ✓');
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

/* =================================================================
   Tela de falha — o app JAMAIS pode terminar num vazio preto.
   O caso real: o navegador entrega o index.html novo e reusa do cache um
   app.js velho (GitHub Pages manda max-age=600 e subrecurso não revalida).
   O script antigo morre procurando elementos que sumiram, e como o CSS
   antigo não conhece .splash nem .login, a tela fica preta e muda.
   Por isso esta função não depende de NENHUM elemento do documento.
================================================================= */
function telaDeFalha(err) {
  const msg = err?.message || String(err);
  console.error('[Ergosphere] falha ao iniciar:', err);
  try {
    for (const id of ['splash', 'app', 'onboard']) $(id)?.classList.add('hidden');
    $('sheetHost') && ($('sheetHost').innerHTML = '');
  } catch (_) { /* documento de outra versão: siga em frente */ }

  document.body.insertAdjacentHTML('beforeend', `<div style="
      position:fixed; inset:0; z-index:9999; display:flex; flex-direction:column;
      align-items:center; justify-content:center; gap:16px; padding:24px; text-align:center;
      background:#08080B; color:#F4F3EE; font:400 15px/1.5 system-ui, sans-serif;">
    <div style="font-size:13px;letter-spacing:.28em;color:#C8A86A;font-weight:600">ERGOSPHERE</div>
    <h1 style="margin:0;font-size:20px;font-weight:600">O app não conseguiu iniciar</h1>
    <p style="margin:0;max-width:38ch;color:#A6A199">Quase sempre é uma versão antiga presa no cache do navegador. Recarregue forçando a atualização.</p>
    <button id="fatalReload" style="
        background:linear-gradient(180deg,#E4C88A,#C8A86A); color:#0b0b0b; border:0; cursor:pointer;
        border-radius:10px; padding:14px 22px; font:600 15px system-ui,sans-serif; min-height:48px;">
      Recarregar agora</button>
    <code style="font-size:11px;color:#6E6960;max-width:44ch;word-break:break-word">${String(msg).replace(/[<>&]/g, '')}</code>
  </div>`);

  document.getElementById('fatalReload')?.addEventListener('click', async () => {
    /* limpa o que pode estar servindo versão velha, depois recarrega do zero */
    try {
      if ('serviceWorker' in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
    } catch (_) { /* nada a fazer */ }
    location.reload();
  });
}

async function boot() {
  try {
    await iniciar();
  } catch (err) {
    telaDeFalha(err);
  }
}

async function iniciar() {
  registrarSW();

  const savedPeriod = parseInt(localStorage.getItem('ads_dash_period') || '0', 10);
  if ([-1, 0, 1, 7, 30].includes(savedPeriod)) period = savedPeriod;
  syncPeriodChips();

  /* o lançamento real é quase sempre o de ontem */
  $('f_data').value = ontemISO();
  $('a_data').value = ontemISO();

  $('formGeral').addEventListener('submit', saveGeral);
  $('formAds').addEventListener('submit', saveAd);
  $('btnCancelGeral').addEventListener('click', resetFormGeral);
  $('btnCancelAds').addEventListener('click', () => resetFormAds());
  $('btnSomarAds').addEventListener('click', somarDosAnuncios);
  $('btnColarDia').addEventListener('click', () => abrirColar('dia'));
  $('btnColarAds').addEventListener('click', () => abrirColar('ad'));
  for (const id of ['f_gasto', 'f_faturado', 'f_compra', 'f_cliques', 'f_visualizacao', 'f_finalizacao', 'f_liquido', 'f_despesas', 'f_reembolso', 'f_chargeback'])
    $(id).addEventListener('input', updatePreviewsGeral);
  for (const id of ['a_gasto', 'a_faturado', 'a_compras', 'a_cliques']) $(id).addEventListener('input', updatePreviewsAds);

  /* chips Ontem/Hoje ao lado do campo de data */
  document.querySelectorAll('[data-setdata]').forEach(b => b.addEventListener('click', () => {
    $(b.dataset.alvo).value = b.dataset.setdata === 'hoje' ? todayISO() : ontemISO();
    if (b.dataset.alvo === 'f_data') updatePreviewsGeral();
  }));

  document.querySelectorAll('#periodChips .chip, #periodChipsAds .chip').forEach(c => c.addEventListener('click', () => {
    period = parseInt(c.dataset.days, 10);
    localStorage.setItem('ads_dash_period', String(period));
    if (period === -1 && !range.de && !range.ate) {
      range = { de: isoAdd(todayISO(), -6), ate: todayISO() };
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

  /* navegação + FAB */
  $('fabLancar').addEventListener('click', () => { navigator.vibrate?.(8); abrirFormDia(); });
  document.body.addEventListener('click', e => {
    const b = e.target.closest('[data-ana-hoje]');
    if (b) irParaAnalise(b.dataset.anaHoje);
  });

  /* configurações (agora dentro da tela Conta) */
  for (const id of ['s_taxa', 's_imposto', 's_margem']) $(id).addEventListener('input', ecoPreviewText);
  $('btnSaveSettings').addEventListener('click', async () => {
    const novo = {
      taxa_pct: parseNum($('s_taxa').value) ?? 0,
      imposto_pct: parseNum($('s_imposto').value) ?? 0,
      custo_por_venda: parseNum($('s_custo').value) ?? 0,
      margem_alvo_pct: parseNum($('s_margem').value) ?? 20,
    };
    if (novo.taxa_pct + novo.imposto_pct >= 100) return toast('Taxa + imposto não podem chegar a 100%.', true);
    const { error } = await db.from('ads_projetos').update(novo).eq('nome', projeto).eq('user_id', uid);
    if (error) return toast('Erro ao salvar economia: ' + error.message, true);

    settings.perdaMax = parseNum($('s_perda').value) ?? DEFAULT_SETTINGS.perdaMax;
    settings.spikePct = parseNum($('s_spike').value) ?? DEFAULT_SETTINGS.spikePct;
    localStorage.setItem('ads_dash_settings', JSON.stringify(settings));

    await loadProjetos();
    toast('Configurações salvas ✓');
    renderAll();
  });
  $('btnRefazerOnboard').addEventListener('click', abrirOnboard);
  ligarInstalacao();

  /* auth */
  $('loginForm').addEventListener('submit', submeterAuth);
  $('btnAuthSwitch').addEventListener('click', alternarModo);
  $('btnEsqueci').addEventListener('click', esqueciSenha);
  $('btnLogout').addEventListener('click', async () => {
    if (!await confirmar({ titulo: 'Sair do Ergosphere?', texto: 'Você vai precisar entrar de novo neste aparelho.', ok: 'Sair' })) return;
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
