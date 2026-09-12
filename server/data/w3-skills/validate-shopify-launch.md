---
name: validate-shopify-launch
description: Validar lançamento de loja Shopify com gates técnicos, comerciais e operacionais. Usar antes de publicar, trocar domínio, liberar checkout ou concluir a fase Virada.
---

# validate-shopify-launch

## Entradas

- Release candidate
- Escopo contratado
- Critérios de aceite
- Configurações de pagamento/frete/pixels
- Plano de rollback

## Processo

1. Executar checklist funcional e visual em breakpoints prioritários.
2. Validar catálogo, preços, estoque, frete, pagamento e mensagens críticas com dados seguros.
3. Verificar SEO técnico, analytics/pixels, performance e acessibilidade.
4. Separar blockers, riscos aceitos e follow-ups.
5. Produzir go/no-go; publicação permanece sob aprovação humana.

## Saída esperada

Matriz de validação, evidências, blockers, riscos, rollback e recomendação go/no-go.

## Critérios de qualidade

- Cada gate possui resultado e evidência.
- Falha crítica implica no-go.
- Nenhum teste cria compra real ou altera produção sem aprovação.

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

Interromper diante de risco de cobrança real, dados de cliente, alteração de produção ou ausência de rollback.
