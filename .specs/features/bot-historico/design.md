# Bot fixo com aba Histórico — design

Data: 2026-09-15. Status: aprovado pelo usuário; advisors Sol/Spark revisaram cursor, realtime e boot.

## 1. Problema

Bots são usados por canais avulsos na sidebar: cada conversa vira uma linha no roster geral, sem lugar fixo por bot, sem busca atravessando sessões, e sem isolamento — o pedido é um bot fixo com conversa atual + Histórico com busca, onde cada conversa tem contexto próprio.

## 2. Decisões (com rationale)

- **Abordagem A com flag (não B, não C).** Cada "Nova conversa" cria um canal ligado ao bot via `channel_agents` (já existe). B (tabela `bot_conversations`) replicaria autorização/restore que canal já tem; C (client-side) só vê canais carregados e não atravessa sessões.
- **Invisibilidade server-side, não filtro de tela (Sol).** Coluna `channels.visivel_no_roster` default `true`; conversa de bot nasce `false`; `ChannelStore.list` exclui `false` no SQL. A sidebar nunca recebe essas linhas — nem busca client-side as vê.
- **Cursor sobre a expressão de ordenação (Sol + Spark).** Ordenação por atividade é mutável, então cursor `{createdAt,id}` do `audit.ts` pula/duplica. Cursor `{activityAt, id}` com `ORDER BY coalesce(last_message_at, created_at) DESC, id DESC` + `WHERE (coalesce(...), id) < ($activityAt, $id)` — tupla `<` casa com `DESC, DESC`. Anomalia documentada: conversa da página 2 que recebe mensagem após a página 1 sobe ao topo já buscado e some da página 2 (mesmo comportamento do roster com socket; EARS-07 prende as duas direções).
- **Busca faseada.** Fase 1: `ILIKE` em `name` + `lastMessage` (colunas existentes; o que a linha mostra é o que a busca alcança — mesma regra do `matchingChannels`). Fase 2 (texto inteiro, depois, sem mudar tela/endpoint): índice de expressão GIN sobre o `jsonb` de `local_thread_history`.
- **Realtime roteado, não invalidado (Sol).** Evento `ChannelActivityEvent` ganha `visivelNoRoster`; cliente roteia `true` → remenda roster, `false` → atualiza query do Histórico e nunca toca no roster. Sem isso, cada mensagem em canal oculto causava `invalidateQueries` inútil do roster (id desconhecido = stale) e o Histórico seguia stale.

## 3. Requisitos (EARS)

- EARS-01: QUANDO a pessoa abre `/bot?agent=<id>`, O SISTEMA mostra a página do bot com abas Conversa e Histórico.
- EARS-02: QUANDO a pessoa aperta "Nova conversa", O SISTEMA cria um canal com `visivel_no_roster=false` ligado ao bot e o abre vazio na aba Conversa; a conversa anterior continua listada no Histórico.
- EARS-03: O SISTEMA NUNCA inclui canal com `visivel_no_roster=false` em `GET /api/channels`.
- EARS-04: QUANDO a pessoa busca no Histórico, O SISTEMA filtra por `name` + `lastMessage` (fase 1); termo presente só no meio da conversa NÃO retorna (limite documentado até a fase 2).
- EARS-05: QUANDO a pessoa clica num item do Histórico, O SISTEMA abre a conversa travada para leitura, com botão Continuar que a torna a conversa ativa.
- EARS-06: QUANDO chega atividade de canal oculto pelo socket, O SISTEMA atualiza a query do Histórico e NÃO invalida `channelKeys.list()`.
- EARS-07: SE uma conversa recebe mensagem entre a página 1 e a página 2, O SISTEMA admite duplicata no topo ou ausência na página 2 (anomalia de ordenação mutável), e NUNCA retorna item já listado na mesma posição duas vezes sem nova atividade.
- EARS-08: O SISTEMA só entrega conversa ao modelo aberta — trocar de conversa nunca concatena históricos (isolamento de contexto).

## 4. Mudanças

**Servidor** (`server/src/`, migração drizzle):
- `db/schema/core.ts`: `channels.visivel_no_roster boolean not null default true` + índice parcial onde `false`.
- `channels/routes.ts`: `create` aceita `{ visivel }`; `list` exclui `false`; `recordActivity` inclui `visivelNoRoster` no evento `pg_notify`.
- Novo `channels/bot-history-routes.ts`: `GET /api/bots/:id/conversas?q=&cursor=&limit=` — membership + `channel_agents.agentId` + `visivel=false`, ordem e cursor da seção 2, clamp de limit 1..100 (padrão `audit.ts`), autorização `isThreadReadableBy`.
- Reabrir usa `GET /api/copilotkit/threads/:threadId/messages` (existente).

**App** (`app/src/`):
- Rota `/bot` ganha abas; aba Histórico = lista (`botKeys.conversas(botId, {q})` via `URLSearchParams`, padrão de `tasks/queries.ts`) + busca com debounce + keyset infinito; item abre canal travado + Continuar.
- Sidebar ganha entrada para `/bot?agent=`; `use-channel-events.ts` roteia por `visivelNoRoster`.
- "Nova conversa" = `POST /api/channels` + navega; semeia cache como `useStartChannel` faz hoje.

## 5. Testes (o que prende o quê)

- Flag: conversa de bot NÃO está em `GET /api/channels`, ESTÁ em `GET /api/bots/:id/conversas`.
- Busca: título acha; termo só-do-meio não acha (fase 1).
- Cursor: 3 conversas, a do meio atualiza após página 1 — prende as duas direções de EARS-07.
- Realtime: atividade em canal oculto NÃO invalida `channelKeys.list()`; atualiza Histórico (EARS-06).
- Navegador: antiga abre travada; Continuar retoma; Nova arquiva e zera.
- Gates do repo antes do commit: `bun test`, `compose config`, biome.

## 6. Fora do escopo

- Fase 2 (FTS no texto inteiro): índice GIN posterior, sem mudar tela.
- Filtro do socket por conexão (payload oculto continua chegando; só o roteamento muda).
- Retenção/expurgo de conversas (histórico de chat nunca é apagado por código hoje).
- Títulos gerados por modelo (título = primeira mensagem / `lastMessage`).

## 7. Self-review

- Placeholder scan: nenhum TBD/TODO; cada EARS tem teste na seção 5.
- Consistência: cursor casa com ORDER BY (DESC,DESC + tupla `<`); flag default `true` preserva canais existentes; `isThreadReadableBy` reusada, não reinventada.
- Escopo: um subsistema (página + endpoint + flag + realtime); fase 2 explicitamente adiada.
- Ambiguidade: "conversa" = canal com `visivel=false` + `threadId` próprio; "travada" = transcript sem composer até Continuar.
