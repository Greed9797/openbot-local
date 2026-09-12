---
name: qualify-sales-opportunity
description: Qualificar oportunidades comerciais da W3 com critérios consistentes e evidência de conversas. Usar em diagnóstico comercial, mudança de estágio, revisão de proposta ou decisão de avançar, nutrir ou encerrar.
---

# qualify-sales-opportunity

## Entradas

- Critérios de qualificação
- Transcrição/notas
- Registro da oportunidade
- Estágio atual
- Próximo passo alegado

## Processo

1. Mapear cada critério para citação, timestamp ou dado verificável.
2. Marcar critério ausente como missing; nunca completar por suposição.
3. Avaliar problema, autoridade, urgência, capacidade de investimento e próximo compromisso.
4. Emitir veredito advance, nurture, close ou insufficient_data.
5. Preparar diff de CRM e perguntas de descoberta para aprovação.

## Saída esperada

Scorecard evidenciado, lacunas, veredito, riscos, perguntas e diff proposto de CRM.

## Critérios de qualidade

- Cada critério contém evidência ou missing.
- O veredito é reproduzível a partir dos critérios.
- Nenhum writeback ocorre sem aprovação humana específica.

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

Interromper se a evidência principal não estiver disponível ou se os critérios de estágio não tiverem sido definidos pela W3.
