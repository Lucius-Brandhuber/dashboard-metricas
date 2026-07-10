# 📊 Dashboard de Métricas — Tráfego Pago

Dashboard para acompanhar métricas diárias de campanhas Meta Ads.

- **No ar:** https://lucius-brandhuber.github.io/dashboard-metricas/
- **Backend:** Supabase (projeto `nyuycffqncuavzuhyofq`), tabelas `ads_metricas_diarias` e `ads_anuncios_diarios` com RLS restrito ao dono.
- **Login:** Supabase Auth (email + senha). Dados sincronizam entre celular e desktop.

## Estrutura

- `index.html` — telas de login e dashboard (abas Visão Geral e Anúncios)
- `js/app.js` — lógica (Supabase, Chart.js, tabelas, CSV, alertas)
- `css/style.css` — tema escuro

## Métricas

**Visão Geral (por dia):** gasto, faturado, front/back-end, CPM, cliques, CPC, visualização de destino, perda de tráfego, finalização de compra, compras, taxa de conversão do checkout (auto), ROI (auto = faturado/gasto).

**Anúncios (por dia, por anúncio):** gasto, CPM, CPC, cliques, CTR, compras, custo por compra (auto), faturado, ROI (auto), hook rate, retenção de vídeo, frequência, status.

Alertas configuráveis (⚙): ROI mínimo, perda de tráfego máxima, pico de CPC/CPM vs média de 7 dias.
