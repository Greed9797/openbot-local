---
name: audit-shopify-store
description: Auditar loja Shopify em UX, conversão, conteúdo, SEO, acessibilidade, performance e configuração. Usar em diagnóstico inicial, revisão pré-projeto ou auditoria periódica.
---

# audit-shopify-store

## Entradas

- URL e ambiente
- Objetivo comercial
- Acessos permitidos
- Dispositivos prioritários
- Baseline disponível

## Processo

1. Confirmar escopo e não executar alterações.
2. Coletar evidências reproduzíveis por página e dispositivo.
3. Avaliar UX/CRO, conteúdo, SEO/schema, acessibilidade e performance sem inventar métricas.
4. Classificar achados P0/P1/P2 por impacto e esforço.
5. Propor correções, dependências e critério de verificação.

## Saída esperada

Relatório priorizado com evidência, impacto, recomendação, owner sugerido e teste de aceite.

## Critérios de qualidade

- Todo achado possui URL ou screenshot.
- Métricas informam ferramenta e timestamp.
- Preferências estéticas não são tratadas como defeitos.

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

Interromper se o alvo não estiver autorizado, protegido por autenticação não fornecida ou exigir contornar controles.
