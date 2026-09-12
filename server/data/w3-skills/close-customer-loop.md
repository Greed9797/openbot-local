---
name: close-customer-loop
description: Detectar compromissos e informações sem destino concluído e preparar o fechamento do loop. Usar após reuniões, em follow-ups, pendências de cliente, CRM e gestão de tarefas.
---

# close-customer-loop

## Entradas

- Transcrições, emails ou notas
- CRM e tarefas
- Janela temporal
- Owners
- Canais permitidos

## Processo

1. Extrair apenas compromissos explícitos e pedidos verificáveis.
2. Deduplicar por conta, compromisso, owner e prazo.
3. Verificar se já existe entrega, resposta ou tarefa concluída.
4. Definir owner, próximo passo e destino correto.
5. Preparar mensagem, tarefa ou atualização e aguardar aprovação quando houver ação externa.

## Saída esperada

Fila de loops abertos com evidência, owner, prazo, artefato preparado e recibo de fechamento.

## Critérios de qualidade

- Não inventar compromissos implícitos.
- Cada loop possui origem e condição clara de fechamento.
- Mensagens preservam fatos e incertezas.

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

Interromper quando o compromisso estiver ambíguo, sem owner legítimo ou depender de decisão comercial.
