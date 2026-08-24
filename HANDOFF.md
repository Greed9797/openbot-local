# Handoff — openbot-local

Estado em 2026-08-24. Este arquivo existe para uma sessão nova conseguir continuar sem reler o
histórico. Detalhe de operação da VPS mora em `docs/vps.md`; aqui está o que é decisão, o que está
medido e o que ficou aberto.

## O que é

Fork do openbot com a licença do CopilotKit removida, rodando na VPS, usando o **Codex CLI na
assinatura do ChatGPT** como modelo. Sem chave de API de modelo em lugar nenhum, e sem telemetria
para o CopilotKit — as duas coisas são requisito do dono, não preferência.

| Onde | O quê |
|---|---|
| `~/dev/openbot-local` | clone de trabalho, branch `local-fork` |
| `root@179.198.104.210:/opt/openbot-local` | o que está no ar; o deploy é `tools/deploy.sh` — ele mesmo busca a origin e confere o commit antes de construir |
| serviços | `openbot`, `agent-codex`, `lightpanda`, `postgres` |
| credencial do Codex | volume `codex-state`, em `/state/codex-home/auth.json`, chmod 600 |

Travas que já custaram caro e continuam valendo:

- A API do taskboard **não tem autenticação**. O bind fica em `127.0.0.1`, nunca `0.0.0.0`.
- `codex exec` sai com **exit 0 em silêncio** sem `--sandbox workspace-write` e
  `sandbox_workspace_write.network_access=true`. Nunca `danger-full-access`.
- SSH só por chave. A senha de root foi rotacionada para um valor que ninguém guardou e
  `PasswordAuthentication` está desligado. Há **uma** chave em `authorized_keys`; perdê-la significa
  usar o console de recuperação do provedor.
- Os `.env` dos projetos removidos ficaram fora do GitHub de propósito
  (`~/backups/vps-srv1866563-2026-08-21/secrets/`, chmod 600). Repositório privado ainda é histórico
  permanente.

## Estado atual

- **984 testes locais, 0 falhas** (`MANAGED_AGENT_TOKEN=teste bun test` na raiz).
- **Bateria de turno único: 44/44** (`tools/bateria/rodar-tudo.sh`).
- **Bateria de conversa: 5/5** (`tools/bateria/conversa.py`, incluída no `rodar-tudo.sh`).
- Smoke do deploy passa nas 5 verificações, incluindo a que prova que o guarda de destino recusa a
  rede interna e ainda deixa passar página pública.

## O que esta sessão fez

### A conversa esquecia a abertura no sétimo turno

Com ferramentas ligadas o Bot **nunca retoma** a sessão do Codex (`--approve-for-me` só existe no
`exec`; sem ela toda chamada MCP volta a pedir aprovação). Sem sessão retomada, o prompt é a memória
inteira — e ele guardava as **últimas seis trocas**. Seis perguntas triviais consumiam a janela e
levavam junto o que a pessoa tinha estabelecido no começo.

Medido contra o Bot rodando, três coisas morrendo na mesma fronteira:

| O quê | Antes | Depois |
|---|---|---|
| número de protocolo dado na abertura, cobrado no turno 9 | "você não me deu nenhum número de protocolo nesta conversa" | responde 84120 |
| regra "comece cada resposta com ABACAXI", turno 8 | parou de valer no turno 7 | continua valendo |
| valor lido numa página, cobrado no turno 9 | perdido | responde certo |

O corte passou a ser por **orçamento de caracteres** (`HISTORY_BUDGET = 12_000` em
`agent-codex/src/index.ts`), a abertura nunca é descartada, e quando algo é cortado o recap **diz
que foi** — sem isso o modelo trata o recorte como a conversa completa e nega com confiança, que é
pior do que esquecer. Travado por testes em `agent-codex/tests/arguments.test.ts`.

### A bateria passou a saber conversar

`tools/bateria/conversa.py` conduz conversas de vários turnos numa thread só, acumulando o histórico
como a interface faz. As conversas estão em `tools/bateria/conversas.json`, com o **porquê** de cada
uma escrito ali dentro. `rodar-tudo.sh` roda as quatro listas de turno único e depois as conversas.

Uma armadilha achada no caminho, e registrada no arquivo: a primeira versão media memória lendo
`https://httpbin.org/uuid`, que devolve valor diferente a cada acesso. O Bot reabria a página — o
comportamento certo — via outro uuid, e a conferência acusava perda de memória. **Para medir memória,
o valor lido tem de ser fixo.**

## Próximos passos

### 1. Google Drive — só o dono consegue fazer

É a única pendência funcional. No Google Cloud: criar projeto, ativar a Drive API, publicar a tela de
consentimento (ou se adicionar como usuário de teste — em modo Testing o refresh token expira em 7
dias), criar um OAuth Client do tipo **Aplicativo da Web** e registrar o endereço de retorno que a
própria tela do Drive exibe. Depois é colar client id e secret na tela. Passo a passo em
`docs/vps.md`. O código do lado de cá está pronto e testado (`server/tests/google-oauth.test.ts`);
a conexão só é salva depois que o Google confirma de quem é a conta.

### 2. ~~`deploy.sh` diz "SMOKE PASSOU" rodando código velho~~ — resolvido

Aconteceu **duas vezes na sessão anterior**: o `git pull` falhou antes (uma vez por branch errada,
outra por arquivo não rastreado no caminho), o `deploy.sh` reconstruiu o código antigo, e as cinco
verificações passaram — porque elas testam capacidade, não versão. Só se notou comparando hash à mão.

Resolvido em 2026-08-24: o `deploy.sh` passou a ser dono do sync. Busca a origin, avança com
`--ff-only`, confere que o HEAD ficou no commit esperado **antes de construir qualquer coisa**, e o
resultado final nomeia o commit que subiu (`SMOKE PASSOU no <hash> <assunto>.`). Recusa de cara:
fetch falho (sem `--local`), branch sem upstream, mudança rastreada não commitada (o build empacota
a árvore como ela está, e isso não seria commit nenhum) e avanço que não seja rápido. A dica de
rollback no fim aponta para o commit exato de antes do deploy. Exercitado em sandbox com 9 cenários
(atrasado limpo; colisão de arquivo; branch sem upstream; árvore suja; divergência; fetch morto sem
e com `--local`; já em dia; smoke reprovando de verdade). Falta a primeira execução real na VPS.

### 3. ~~Decidir se as conversas entram no cron~~ — decidido e conferido na VPS

Decisão de 2026-08-24: **sim, junto com a bateria**. Conferido na VPS que já é assim: as duas
entradas estão ativas (o handoff anterior dizia comentadas — estava velho), `17 * * * *` roda
`tools/monitorar.sh smoke` e `40 4 * * *` roda `tools/monitorar.sh bateria`, que chama
`rodar-tudo.sh` — turnos únicos e conversas. Nada a mudar no crontab.

### 4. ~~O orçamento de 12k caracteres nunca foi exercitado de verdade~~ — exercitado e medido

Resolvido em 2026-08-24 com a conversa `c6-orcamento-cortado` (em `tools/bateria/conversas.json`):
~21 mil caracteres de enchimento forçam o corte de verdade. Corrida real contra o Bot na VPS,
11 turnos: o protocolo dado na abertura voltou (`55501`), e cobrada pelo código secundário que caiu
fora do prompt, a resposta foi "não estou vendo esse trecho omitido da conversa" — o Bot admitiu o
corte em vez de inventar, que é exatamente o que o marcador manda. Antes da corrida, o tamanho foi
conferido simulando o `recapDe` real (recap de 12.109 caracteres). O degrau seguinte — resumir os
trechos cortados em vez de descartar — continua aberto e custa outra chamada de modelo por turno;
com o comportamento atual medido como correto, não é urgente.

### 5. Referência implícita reabre a página todo turno

Na conversa `c5`, "quantos links tem nessa página?" faz o Bot reabrir (15–17 s por turno). Está certo
e é o que o `AGENTS.md` manda, mas é caro. Se incomodar, é aqui que entra guardar o que foi lido.

### 6. ~~Quem decide chamar a ferramenta é o Codex~~ — agora com uma rede de segurança no código

Quatro alavancas medidas: regra no prompt (fraca), `AGENTS.md` (forte — levou de 0/3 para 3/3),
bloquear a rede do shell (**quebrou tudo**: com `network_access=false` toda chamada MCP volta a
pedir aprovação, 40 de 44 tarefas falharam, revertido e documentado no código) e, desde 2026-08-24,
**o reforço** (`agent-codex/src/index.ts`): turno que termina com pergunta citando endereço,
resposta dada e nenhuma chamada é rodado **uma segunda vez**, com ordem explícita de abrir a página;
a resposta de memória sai na tela seguida da marcação "_reprovada_" e da resposta lida. Se a segunda
passagem também não abrir, o aviso honesto de "nenhuma página foi aberta" permanece. O reforço diz
no log do container quando disparou e como terminou. De quebra, `avisoDeOutraPagina` (abriu domínio
errado) estava definida desde o incidente W3bsite mas nunca tinha sido ligada ao fluxo — hoje é
avaliada sobre as passagens somadas. Medido na VPS: t03 + t28 ×3 = 6/6 com leitura real, nenhum
aviso. O teto continua sendo o modelo; a diferença é que memória sem leitura virou exceção tratada,
não resposta silenciosa.

## Como rodar as coisas

```bash
# testes locais (a suíte avisa sozinha se o banco de teste estiver sem schema)
cd ~/dev/openbot-local && MANAGED_AGENT_TOKEN=teste bun test
```

O banco de teste é o Postgres do compose (`pgvector/pgvector:pg17`, porta 55432 que está no `.env`),
não um Postgres instalado à mão. Nesta máquina o Docker vem do **colima**: se a suíte falhar em massa
com `Connection closed` e o log do Postgres não tiver linha nenhuma, é `colima start` +
`docker compose up -d postgres` e pronto. Armadilha medida em 2026-08-24: contra o Postgres 18
nativo do Homebrew, toda conexão que o Bun abre por `::1` morre no servidor
(`setsockopt(TCP_NODELAY) failed`) — por `127.0.0.1` passa. Se um dia o teste rodar contra o banco
nativo, use IP, não `localhost`.

```bash
# deploy (na VPS; o script busca a origin e recusa construir código velho)
bash tools/deploy.sh                      # tudo
bash tools/deploy.sh agent-codex          # um serviço
bash tools/deploy.sh --local agent-codex  # reconstrói o commit de pé, sem falar com a origin

# validação inteira (turno único + conversas)
bash tools/bateria/rodar-tudo.sh general-assistant

# só uma conversa
python3 tools/bateria/conversa.py general-assistant tools/bateria/conversas.json --so=c2-fato-longe

# diagnóstico de um turno estranho
bash tools/diagnosticar.sh
```
