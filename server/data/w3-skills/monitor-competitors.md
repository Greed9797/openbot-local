---
name: monitor-competitors
description: Monitorar mudanças materiais de concorrentes da W3 ou de clientes. Usar para pricing, posicionamento, produto, portfólio, contratação e sinais de mercado.
---

# monitor-competitors

## Entradas

- Watchlist aprovada
- URLs e aspectos monitorados
- Snapshot anterior
- Materiality threshold
- Destino privado

## Processo

1. Capturar páginas públicas sem contornar barreiras.
2. Comparar com o snapshot anterior.
3. Eliminar mudanças cosméticas e ruído.
4. Classificar impacto provável e confiança.
5. Gerar brief apenas quando a mudança superar o threshold.

## Saída esperada

Diff datado com evidências, interpretação marcada, impacto potencial e ação recomendada.

## Critérios de qualidade

- Todo fato cita URL e timestamp.
- A inferência não é apresentada como intenção do concorrente.
- Sem mudança material, emitir quiet result.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper em paywall, autenticação, bloqueio anti-bot ou ausência de baseline comparável.
