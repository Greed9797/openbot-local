---
name: monitor-sales-pipeline
description: Monitorar saúde do pipeline da W3 e preparar correções. Usar em revisão de funil, previsão, leads parados, higiene de CRM e identificação de risco comercial.
---

# monitor-sales-pipeline

## Entradas

- Snapshot do CRM
- Histórico de atividades
- Regras de estágio
- Metas e período
- Owners

## Processo

1. Comparar o snapshot atual com o anterior.
2. Detectar ausência de próxima ação, aging, estágio sem evidência e forecast inconsistente.
3. Separar risco de dados incompletos de risco real do negócio.
4. Priorizar exceções por receita, probabilidade e urgência.
5. Preparar mudanças de CRM e cobranças de owner sem executá-las.

## Saída esperada

Pulse do pipeline com mudanças, riscos, oportunidades paradas, lacunas de CRM e ações propostas.

## Critérios de qualidade

- Forecast informa período e critério.
- Nenhuma atividade é inferida sem registro.
- Execuções sem mudança material produzem quiet result.

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

Interromper se o snapshot não tiver data, owner ou estágio comparável.
