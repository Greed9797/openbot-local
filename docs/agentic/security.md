# Segurança

As fronteiras do runtime agêntico: o que impede o modelo de sair do trilho e o que continua
sendo risco conhecido. Implementado sem homologação em ambiente real.

## O gateway é o único caminho

- Toda ação do runtime passa por `ComputerGateway.govern` (`server/src/computer/gateway.ts`):
  resolve o ref contra o snapshot persistido (geração exata — página que mudou exige nova
  observação), monta o contexto CEL, avalia a política (`policy.ts`), **grava a auditoria
  antes de executar** (`computer.action_allowed` / `action_refused` / `action_failed` em
  `server/src/audit.ts`) e só então chama o computador. Recusa vira `ActionRefusedError`
  e chega ao modelo como `refused`, não como erro para tentar de novo.
- Política nega por padrão; regra quebrada recusa. `computer_navigate` e `computer_fetch`
  também são governados (`COMPUTER_ACTING_TOOLS` em `server/src/computer/schema.ts`) —
  senão "ler rápido" contornaria por fora o que a regra proíbe chegar devagar.
- Nada de Playwright ou JS para o modelo: o catálogo de `createBrowserTools` (13 nomes
  fixos) é tudo o que existe; argumento `ref`/`snapshotId` vem da observação, e ferramenta
  desconhecida é resposta inválida, não execução. Controle humano vence: com `holder:
  'human'`, ação do Bot é recusada (`assertBotMayAct`, `HumanHasControlError` → espera
  `waiting_human`, sem gastar passos contra a parede).

## Para onde o Bot pode ir, e para onde o servidor pode apontar

- **A rede interna, por Bot.** `checkNavigationTarget` (`computer/target.ts`) recusa, antes de
  qualquer requisição, endereço que seja o deste deployment: IP privado, `localhost`, nome sem
  ponto (é assim que um serviço do mesmo compose se chama) e os apelidos de credencial de nuvem —
  esses últimos nunca, nem com permissão. Quem responde "sim" é o cadastro do Bot
  (`agents.configuration.allowPrivateNavigation`, desligado por padrão, com o que ele abre escrito
  no formulário) ou `COMPUTER_ALLOW_PRIVATE_NAVIGATION=true` para o deployment inteiro. Erro ao ler
  o cadastro é "não" com aviso no log. A recusa é auditada como `computer.action_refused` com
  `cause: private_network` — a decisão de política vai como foi, sem inventar uma regra que não
  olhou o endereço —, e o passo da tarefa mostra o motivo e a saída para quem estava esperando.
- **Servidor MCP fora do catálogo, por URL.** `customUrlRefusal` (`plugins/catalogue.ts`) exige
  `https` e host público antes de guardar o endereço: sem isso, "adicione um servidor MCP" é um
  primitivo de requisição para onde o servidor alcança, com o token do cofre no cabeçalho.
  `PLUGINS_ALLOW_PRIVATE_MCP=true` é a decisão de administrador que aceita uma API da casa (rede
  interna, http) — ela é registrada em `mcp_servers.addedBy`, e cada servidor que só passou por causa
  dela leva `privateNetwork: true` no evento `configuration.changed`. O endereço de credencial de
  nuvem continua recusado mesmo assim, e toda recusa que o interruptor abriria diz o nome dele.

## Classificação de artefatos e destinos

- `classifyCapture` (`image-input.ts`): host em `AGENT_SENSITIVE_HOSTS` (comparação exata
  ou por sufixo de domínio) → `sensitive`, destinos só `["panel"]`; senão `internal`,
  destinos `["panel","model","telegram"]` (`ARTIFACT_DESTINATIONS`). A lista vazia (padrão)
  não é licença: retenção e destinos continuam valendo.
- `imageForModel` é a autorização: sem `"model"` nos destinos, com classificação `secret`
  ou com `retentionUntil` vencida, devolve `undefined` — e o passo registra o motivo via
  `refusalReason` em vez de omitir o campo. Base64 só no caminho até o adaptador; passos,
  eventos e logs guardam id e metadados.
- `createArtifactStore`: bytes em `AGENT_ARTIFACTS_DIR/<runId>/<id>.<ext>` (extensão por
  `EXTENSIONS`), **arquivo primeiro, linha depois** — nunca existe linha apontando para
  arquivo inexistente; leitura órfã apaga a linha e responde "não tenho isto". Retenção por
  linha (`retentionUntil`, padrão `AGENT_ARTIFACT_RETENTION_DAYS = 7`, `null` = para sempre),
  faxina em `deleteExpired` (50 por passagem). Nenhum `chmod` próprio no código: valem as
  permissões do processo/volume — ver `vps.md`.

## Redação e mascaramento de segredo

- `redactSecrets` (`redact.ts`): só padrões de alta confiança sobre o texto da página
  antes de virar observação — cabeçalho de autorização, chaves de API conhecidas, JWT
  (`eyJ…`), valor após rótulo (`senha:`/`api_key =`), cartão 13–19 dígitos **com Luhn**.
  Marcador `[redigido]` (`REDACTED`), contagem em `observation.redactions`, regras que
  dispararam sem os valores. Regex largo "por precaução" é proibido de propósito: estraga
  tarefas legítimas (nº de pedido, código de barras).
- Screenshot: `SCREENSHOT_MASK_SELECTORS` (`agent-computer/src/index.ts`) pinta
  `input[type="password"]` sempre + `SCREENSHOT_MASK_SELECTORS` do deployment via `mask`
  do Playwright; a contagem (`shot.masked`) vira `protection: "masked"` e zero denuncia
  máscara que não casou mais nada. Durante `secretWanted`, a captura é **recusada**
  (`observation.ts`, `browser-tools.ts` `requestScreenshot`, endpoint do agent-computer) —
  a foto devolveria ao modelo exatamente o valor que o caminho de segredo protege.
- O valor do segredo nunca é retornado, registrado nem auditado — só `characters`
  (`agent-computer/src/control.ts`); rótulo é o único dado guardado.

## Aprovação por hash de ação

- `classifyAction` (`sensitive-actions.ts`): verbos de efeito externo em PT/EN por palavra
  inteira (`publicar`, `comprar`, `excluir`, `convidar`, `configurar`…​ em `ACTING_WORDS`),
  caminhos finais (`ACTING_PATHS`: `/checkout`, `/publish`, `/admin`…), ferramentas sempre
  sensíveis (`submit_form`, `publish`), argumentos (`ACTING_KEYWORDS`) e
  `AGENT_APPROVAL_PATTERNS` do deployment (comparado a ferramenta, rótulo e argumentos).
- `createApprovalGate` (`approvals.ts`): sensível vira linha em `run_approvals` com
  `actionHashOf(call)` (SHA-256 de `stableStringify`, em `loop.ts`) + ação + `destination`
  + `expectedEffect` + `expiresAt` (`AGENT_APPROVAL_TTL_MINUTES`, padrão 30). O sim é
  **gasto uma vez** (`consumeApproval` valida hash): aprovou este clique, não o próximo.
  "Aprovado e vivo" reaproveita sem perguntar de novo; "negado" é lembrado e chega ao
  modelo como informação; `expired` sai no relógio do worker (`expireApprovals`).
- Decisões auditadas (`agent_run.approval_approved` / `approval_denied`); painel e Telegram
  decidem pelo mesmo `decideApproval`.

## Token do Telegram fora de log

- `client.ts`: o token só existe na URL montada ali; `describeFailure` reconstrói o erro a
  partir de `description`, sem a URL. Nem log, nem erro, nem auditoria carregam o token.
  `fetch` injetável mantém a suíte sem credencial.

## Riscos conhecidos (assumidos, não resolvidos)

- **Codex delegado tem shell próprio.** O modo `delegated` entrega a tarefa ao serviço do
  Codex; o runtime não promete shell governado — só as ferramentas MCP de navegador passam
  pelo gateway. `danger-full-access` é recusado pelo serviço (`docs/vps.md`, auditoria
  A05). Nunca dê a uma tarefa delegada um Bot com mais shell do que a tarefa precisa.
- **gVisor opcional.** O compose prevê runtime dedicado por computador (comentário
  `COMPUTER_RUNTIME`/runsc); fora dele, o Chromium roda sem essa camada. Perfis usam
  `--password-store=basic` sempre; sandbox do Chromium só com `COMPUTER_SANDBOX=on`
  (auditoria A11).
- **Máscara não é prova de limpeza** (comentário em `agent-computer/src/index.ts`): a
  decisão de destino é a classificação no servidor, não a pintura no navegador.
- **`AGENT_SENSITIVE_HOSTS` vazio por padrão**: sem a lista do deployment, tudo é
  `internal` e pode ir a modelo/Telegram. Quem opera prontuário, extrato ou credencial
  precisa listar os hosts.
- **Sem homologação real**: nenhum fluxo sensível de verdade (compra, publicação,
  credencial) foi exercitado contra site real; o caminho foi provado com fixtures/mocks.
