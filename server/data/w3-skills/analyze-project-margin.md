---
name: analyze-project-margin
description: Analisar margem de projetos e serviços da W3 com dados rastreáveis. Usar em precificação, revisão de rentabilidade, controle de escopo, capacidade e análise mensal.
---

# analyze-project-margin

## Entradas

- Receita contratada
- Horas/custos
- Terceiros e ferramentas
- Mudanças de escopo
- Método contábil e período

## Processo

1. Validar período, moeda e fonte de cada valor.
2. Separar custo direto, alocação e estimativa.
3. Calcular margem bruta e cenários com fórmulas explícitas.
4. Identificar variação por escopo, retrabalho, atraso e capacidade.
5. Preparar ações e decisões financeiras sem alterar preço ou orçamento.

## Saída esperada

Painel de margem por projeto/tipo, drivers, cenários, riscos e decisões recomendadas.

## Critérios de qualidade

- Nenhum valor é inventado.
- Estimativas estão marcadas e acompanhadas de sensibilidade.
- A fórmula é reproduzível.

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

Interromper quando dados de custo/receita forem incompatíveis ou a regra de reconhecimento não estiver definida.
