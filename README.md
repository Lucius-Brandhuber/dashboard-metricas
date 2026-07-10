# 📊 Dashboard de Métricas — Tráfego Pago

Dashboard para acompanhar métricas diárias de campanhas Meta Ads e decidir o que escalar e o que cortar.

- **No ar:** https://lucius-brandhuber.github.io/dashboard-metricas/
- **Backend:** Supabase (projeto `nyuycffqncuavzuhyofq`), tabelas `ads_projetos`, `ads_metricas_diarias` e `ads_anuncios_diarios` com RLS restrito ao dono.
- **Login:** Supabase Auth (email + senha). Dados sincronizam entre celular e desktop.

## Projetos

Cada projeto é uma pasta isolada, com seus próprios dias e anúncios. A barra no topo troca de projeto, cria (＋ Novo), renomeia (✎) e exclui (🗑, com confirmação por digitação do nome). Excluir um projeto apaga todos os dias e anúncios dele. No ranking, o 🗑 de cada linha apaga o anúncio inteiro.

## Economia do projeto (⚙)

Digitada **uma vez por projeto**: taxa do gateway (%), imposto sobre vendas (%), custo por venda (R$) e margem alvo (%).

A partir dela o painel deriva, sem você digitar nada por dia:

```
receita_liquida = faturado × (1 − (taxa + imposto)/100) − reembolsos − chargeback
lucro           = receita_liquida − gasto − custo_por_venda × compras − despesas
margem          = lucro / receita_liquida
breakeven ROAS  = 1 / (1 − (taxa + imposto)/100)
ROAS alvo       = breakeven × (1 + margem_alvo)
CPA alvo        = ticket_liquido / (1 + margem_alvo)
```

Sem a economia configurada, o lucro sai rotulado **“estimado (bruto)”**.

## Métricas

**Visão Geral (por dia):** gasto, faturamento bruto, compras, cliques, visualizações de página, checkouts iniciados (IC), CPM, CPC, perda de tráfego. Opcionais: vendas iniciadas, faturamento líquido (override), despesas, reembolsos, chargeback, vendas pendentes, mix front/back-end.

**Anúncios (por dia, por anúncio):** gasto, faturado, compras, CPM, CPC, cliques, CTR, custo por compra (auto), ROAS (auto), hook rate, retenção de vídeo, frequência, status.

## Gráficos

Lucro por dia (barras divergentes) · Lucro acumulado · ROAS com linha de breakeven · Gasto vs Receita líquida · Funil do Meta (cliques → página → checkout, agregado do período) · Aprovação no checkout (etapa do gateway, separada) · Gasto por anúncio (dentro do detalhe do dia).

Ratios de um único dia não viram gráfico: com poucas vendas por dia, uma venda a mais ou a menos move a linha de 0% a 100%. No dia mostramos **quanto** (R$ e contagens); no período, **quão bem** (ROAS, margem, taxas).

## Ponte dia → anúncios

Clicar numa linha da tabela de dias (ou numa barra do gráfico de lucro) abre, ali mesmo, o gasto por criativo daquele dia, a tabela dos anúncios com lucro e ROAS, e quanto do gasto do dia os anúncios cobrem. O botão **Σ Somar dos anúncios** preenche o dia a partir dos anúncios já lançados.

## Veredito dos anúncios

`diagnose()` decide entre **Coletando dados · Manter · Testar novo criativo · Cortar · Escalar**. O gate é **gasto acumulado**, não dias de calendário: zero venda com R$ 8 gastos é o estado esperado, não um criativo morto. Só se fala em escalar acima de 10 conversões acumuladas.

## Estrutura

- `index.html` — login e dashboard (abas Visão Geral e Anúncios)
- `js/app.js` — lógica (Supabase, Chart.js, métricas derivadas, tabelas, CSV, alertas)
- `css/style.css` — tema escuro
