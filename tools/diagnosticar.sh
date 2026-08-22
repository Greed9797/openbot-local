#!/usr/bin/env bash
# Por que o Bot respondeu sem usar o navegador?
#
# Esta pergunta custou horas nesta base, e não por ser difícil: os sinais que a respondem moram em
# cinco lugares diferentes, e nenhum deles é o primeiro que se olha. Já procurei em cache, plugins,
# orçamento de contexto e assinatura de execução antes de descobrir que o arquivo de instruções tinha
# sido apagado por uma tarefa anterior.
#
# A ordem aqui é a ordem de probabilidade, não a de elegância.
#
#   bash tools/diagnosticar.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
COMPOSE="docker compose -f /opt/openbot-local/docker-compose.yml"

echo "1. As instruções estão no lugar?"
echo "   (a causa mais comum: o Bot as apaga mexendo no /workspace, e volta a responder de memória)"
$COMPOSE exec -T agent-codex sh -c 'ls -la /workspace/AGENTS.md 2>&1 | head -1; echo "   workspace:"; ls /workspace 2>/dev/null | head -5' | sed "s/^/   /"

echo
echo "2. O serviço acha que tem ferramentas?"
$COMPOSE exec -T agent-codex bun -e \
  'const r = await fetch("http://localhost:4202/health"); console.log(await r.text())' 2>/dev/null | sed "s/^/   /"

echo
echo "3. O servidor de ferramentas sobe agora, falado pelo protocolo?"
$COMPOSE exec -T agent-codex sh -c \
  'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"d\",\"version\":\"1\"}}}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}" | OPENBOT_AGENT_TOKEN=probe OPENBOT_RUN=probe OPENBOT_BOT_ID=self timeout 15 bun /app/agent-codex/src/mcp-computer.ts 2>&1 | grep -o "\"name\":\"[a-z_]*\"" | wc -l' \
  2>/dev/null | sed "s/^/   ferramentas oferecidas: /"

echo
echo "4. Alguma ação chegou ao gateway nos últimos 30 minutos?"
echo "   (zero aqui com o Bot 'respondendo bem' é a assinatura de resposta inventada)"
$COMPOSE exec -T postgres psql -U openbot -d openbot -tAc \
  "select event_type, count(*) from audit_events
   where created_at > now() - interval '30 min' and event_type like 'computer.action%'
   group by 1 order by 2 desc" 2>/dev/null | sed "s/^/   /"

echo
echo "5. O último turno chegou com a declaração de execução?"
echo "   (sem ela o servidor de ferramentas sai no boot e o Codex não oferece nada)"
$COMPOSE logs --since=30m agent-codex 2>&1 | grep "declaração de execução" | tail -3 | sed "s/^/   /"

echo
echo "6. O último turno do Codex chegou a ver as ferramentas?"
$COMPOSE exec -T agent-codex sh -c \
  'F=$(ls -t $CODEX_HOME/sessions/*/*/*/*.jsonl 2>/dev/null | head -1); [ -n "$F" ] || { echo "sem sessões"; exit 0; }
   echo "arquivo: $(basename $F)"
   echo "chamadas de ferramenta: $(grep -c mcp_tool_call "$F")"
   echo "pediu aprovação: $(grep -c "APPROVAL REQUEST" "$F")"' 2>/dev/null | sed "s/^/   /"

echo
echo "Leitura rápida:"
echo "  AGENTS.md ausente ......... o Bot apagou; o próximo turno recria, mas o turno de agora foi sem ele"
echo "  ferramentas: false ........ o servidor MCP não subiu — ver (3) e o stderr no log do serviço"
echo "  ações = 0 e Bot respondeu . resposta de memória; confira (1) antes de qualquer outra coisa"
echo "  APPROVAL REQUEST > 0 ...... alguma config tirou o --approve-for-me de cena (ex: rede do sandbox)"
