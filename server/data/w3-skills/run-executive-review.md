---
name: run-executive-review
description: Conduzir revisão executiva da W3 com prioridades, bloqueios, decisões e responsáveis. Usar em reviews diários ou semanais, pedidos de priorização e preparação de pauta para direção.
---

# run-executive-review

## Entradas

- Período e objetivos
- Pipeline comercial
- Projetos e bloqueios
- Margem/capacidade
- Decisões e aprovações pendentes

## Processo

1. Consolidar somente dados do período solicitado.
2. Separar sinais, riscos e decisões; eliminar atualizações sem consequência.
3. Ordenar por impacto, urgência, reversibilidade e dependências.
4. Propor no máximo cinco prioridades com owner e próximo marco.
5. Preparar as decisões para o humano; não executá-las.

## Saída esperada

Brief executivo: placar, mudanças relevantes, riscos, decisões requeridas, cinco prioridades e responsáveis.

## Critérios de qualidade

- Cada prioridade possui resultado esperado, owner e prazo.
- Todo número informa fonte e período.
- Itens sem novidade ficam em quiet mode.

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

Interromper se faltarem os sistemas de origem ou se duas prioridades críticas exigirem uma escolha de negócio não documentada.
