# Relatório de entrega — OpenBot agêntico

O que foi construído, com que evidência, e o que ficou sem homologação. Complementa
`implementation-plan.md` (o plano, escrito antes) e `tasks.md` (o vocabulário do runtime): aqui está
o resultado medido, comando por comando.

Base auditada: `0e623a1` (branch `local-fork`). Trabalho na mesma branch, sem reescrita: o que
existia de navegador, perfis, política e auditoria continua sendo o caminho, e o que entrou foram o
runtime, os canais e a persistência em volta dele.

## 1. Evidência global

| Comando | Resultado real |
|---|---|
| `bun run test:ci` (raiz) | **1147 pass, 5 skip, 0 fail** em 116 arquivos, 10,5 s (piso do CI: 400) |
| `cd server && bun run typecheck` | limpo (`tsc --noEmit`) |
| `cd app && bun run typecheck` | limpo (`tsc --noEmit`) |
| `bunx biome lint .` | sem achados nos arquivos novos |
| Navegador (Chromium, sessão real) | lista, criação, detalhe, passos, conversa, aprovação, pausa/retomada/cancelamento, captura e pareamento exercitados à mão — seção 7 |

A suíte partiu de 984 testes (medida do `HANDOFF.md` anterior) e terminou em 1152 no total, incluindo
os 998 da base: nada foi removido para o número subir.

## 2. Fase 1 — Tarefas duráveis

Commit `b5fbd39`.

- Esquema novo em `server/src/db/schema/agentRuns.ts` (11 tabelas, enums próprios), migração gerada;
- `server/src/agent-runs/{types,repository,service,routes}.ts`: ciclo de vida com dono e geração de
  lease, idempotência por chave, passos, eventos, mensagens, aprovações, orçamento;
- rotas HTTP em `/api/agent-runs` (criar, ler, listar, passos, eventos, mensagens, pausar, retomar,
  cancelar, aprovar/negar, captura);
- executor de fundo no boot, com worker opcional.

Prova: testes de integração de repositório e rotas, e a criação real de tarefas pela API durante a
verificação de interface (`POST /api/agent-runs` devolveu `status: queued` e a tarefa andou sozinha
até o primeiro passo).

## 3. Fase 2 — Runtime

Commit `bedb809`.

- `server/src/agent-runtime/{contracts,loop,observation,prompt,registry}.ts`;
- ciclo observar → decidir → agir com correção limitada (2 correções antes de `waiting_human`);
- modos `step` e `delegated`, sem dois planejadores na mesma tarefa;
- retomada de `needs_reconciliation` só por pessoa, com motivo.

Prova: `server/tests/agent-runtime-loop.integration.test.ts` (13 casos) com provedor roteirizado e
computador falso, incluindo pausa durante a chamada de modelo (custa zero ação), orçamento estourado
e resultado incerto. No navegador, a tarefa criada pela tela executou o primeiro passo de observação
de verdade e falhou fechado quando o computador não estava no ar (mensagem `INTERNAL: The assistant's
computer is not running.`), em vez de inventar sucesso.

## 4. Fase 3 — Ferramentas, visão e artefatos

Commit `27b43cb`.

- `browser-tools.ts` (toda ação pelo `ComputerGateway`, com `runId`/`stepId` no `ActionActor`);
- `image-input.ts`, `artifact-store.ts`, `redact.ts`: captura classificada, com máscaras, hash,
  retenção e destinos permitidos;
- `agent-computer` ganhou `select_option`, `hover` e máscaras na captura; `agent-codex` passou a
  entregar a imagem como conteúdo, não como texto.

Prova: testes de payload por provedor e de artefato; a captura real aparece na tela de tarefa quando
existe navegador, e quando não existe a tela diz o motivo em linha (verificado à mão, seção 7).

## 5. Fase 4 — Provedores intercambiáveis

Commit `27b43cb`.

- `providers/{openai-responses,anthropic,openai-compatible,codex-cli}.ts` atrás de
  `AgentModelProvider`, com `capabilities.vision` verificada;
- `model_configurations` semeado do env; `docs/agentic/providers.md`.

Prova: testes de cada transporte com resposta gravada; o registro recusa tarefa que exige visão a
provedor sem visão.

## 6. Fase 5 — Telegram

Commit em que este relatório entra.

- `server/src/telegram/{client,store,handler,poller,sender,notifier,routes}.ts`;
- caixa de entrada deduplicada por `(bot, update_id)`, caixa de saída persistente com tentativa e
  intervalo, notificação de aprovação com botões;
- comandos `/start`, `/status`, `/tasks`, `/tela`, `/pausar`, `/continuar`, `/cancelar` e linguagem
  natural que vira tarefa no mesmo runtime;
- pareamento de uso único começado **no painel** (tela de Tarefas, seção Telegram).

Prova: `telegram-handler`, `telegram-store.integration`, `telegram-poller.integration`,
`telegram-routes` e `telegram-notifier.integration`; e uma conferência de ponta a ponta fora da
suíte — o código gerado pelo painel foi entregue ao manipulador real e virou vínculo no banco:

```text
Pronto. Este chat agora opera o Bot general-assistant. Escreva o que fazer.
vínculo no banco: {"telegramUserId":"123456789","chatId":"123456789","botId":"general-assistant"}
```

Depois disso, a própria tela listou o vínculo e o botão "Desligar" o removeu.

## 7. Fase 6 — Aprovação e intervenção humana

Commit `e32f972`.

- classificador de ação sensível (publicar, enviar, comprar, pagar, apagar, convidar, permissão),
  extensível por `AGENT_APPROVAL_PATTERNS`;
- `run_approvals` com hash da ação, validade e consumo único; `waiting_approval` para a tarefa;
- segredo em digitação bloqueia captura, para não fotografar senha.

Prova: testes de aprovação (aprovar, negar, expirar, decidir duas vezes) e um ciclo completo à mão:
uma aprovação pendente apareceu no painel, "Aprovar" a marcou como decidida com autor e hora, e a
conversa ganhou a mensagem de sistema correspondente (marcada como ainda não entregue ao modelo).

## 8. Fase 7 — Formulário (prova do caso TikTok)

Commit `e32f972`.

- `form-extract.ts`: lê o snapshot do gateway e devolve campos, tipos, obrigatoriedade, opções de
  select e grupos de rádio, além dos botões;
- ferramenta de extração exposta ao modelo pelo catálogo, com o formulário preenchido pela pessoa.

Prova: `server/tests/agent-form-extract.test.ts` (7 casos) sobre um snapshot sintético. **Nenhuma
tarefa real foi executada contra o TikTok** — depende de conta e de navegador homologado na VPS.

## 9. Fase 8 — Hardening e operação

- Recuperação: lease com geração, `needs_reconciliation` para efeito incerto, nunca repetir submit;
- observabilidade: eventos por tarefa e por passo, com carga dobrável no painel;
- segurança: `docs/agentic/security.md` — política, auditoria antes da ação, artefatos, Telegram;
- VPS: `docs/agentic/vps.md`, limites de um run de navegador por vez, defaults de publicação e
  checagem de asset do Lightpanda.

Prova: a bateria inteira passa e os documentos descrevem o que o código faz, arquivo por arquivo.

## 10. O que não está homologado

Nada aqui é marcado como concluído operacionalmente sem ter rodado de verdade. O que **não** rodou:

| Item | Por quê | O que falta |
|---|---|---|
| Tarefa real contra o TikTok | sem conta e sem navegador na VPS a partir desta máquina | instalar e rodar na VPS, com perfil logado |
| Telegram de verdade | sem token: o canal só sobe com `TELEGRAM_BOT_TOKEN` | token do @BotFather e a allowlist numérica |
| Modelo pago de visão | sem credencial no `.env` local | uma chave e uma tarefa que exija enxergar |
| Codex conduzindo `delegated` | o serviço `agent-codex` não estava no ar | subir o `agent-codex` com a assinatura |
| Captura com navegador | `agent-computer` não estava no ar | subir o computador e pedir "me manda a tela" |

O caminho exercitado à mão foi o que dá para exercitar aqui: tarefas de verdade no banco (criadas,
pausadas, retomadas, canceladas, com passo e evento gravados), aprovação decidida, conversa
respondida, pareamento consumido e captura falhando com a mensagem certa em vez de silêncio.

## 11. Riscos que continuam de pé

- **Um navegador para todos os Bots** — `COMPUTER_SUPERVISOR_URL` separa por Bot, mas o padrão é
  compartilhado; duas tarefas no mesmo perfil se esperam pelo lease.
- **Leitura de página é o gargalo** — o modelo decide sobre o texto do snapshot; página que esconde o
  essencial atrás de canvas (como o próprio TikTok pode fazer) depende de captura e visão.
- **Codex CLI é uma segunda fronteira** — no modo `delegated` ele tem shell; o runtime não promete
  shell governado, e isso está dito em `security.md`.
- **VPS pequena** — um run de cada vez, 40 passos, 15 minutos; subir dois é o caminho para a fila
  virar espera longa.
