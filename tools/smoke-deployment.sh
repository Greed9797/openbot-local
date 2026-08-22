#!/usr/bin/env bash
# O mínimo que tem de ser verdade depois de um deploy, em menos de um minuto.
#
# Existe porque todo defeito sério deste fork tinha a mesma assinatura: o sistema respondia bem
# enquanto estava quebrado. Um Bot sem ferramentas conversa; um guarda de destino desligado devolve
# páginas; instruções apagadas não aparecem em log nenhum. `docker compose up -d` sair com zero não
# diz nada sobre nenhuma das três.
#
#   bash tools/smoke-deployment.sh [agente]
set -uo pipefail

AGENTE="${1:-risk-analyst}"
API="http://127.0.0.1:3001"
COMPOSE="docker compose -f /opt/openbot-local/docker-compose.yml"
falhou=0

reprovar() { echo "  REPROVOU: $1" >&2; falhou=1; }
aprovar()  { echo "  ok: $1"; }

echo "1. O Bot tem navegador?"
saude=$($COMPOSE exec -T agent-codex bun -e \
  'const r = await fetch("http://localhost:4202/health"); console.log(await r.text())' 2>/dev/null)
case "$saude" in
  *'"ferramentas":true'*) aprovar "as ferramentas subiram" ;;
  *) reprovar "o /health não confirma as ferramentas: ${saude:-sem resposta}" ;;
esac

echo "2. As instruções estão no lugar?"
if $COMPOSE exec -T agent-codex test -f /workspace/AGENTS.md 2>/dev/null; then
  aprovar "AGENTS.md presente"
else
  # Não é fatal: elas são reescritas no próximo turno. É sinal de que algo as apagou.
  echo "  aviso: AGENTS.md ausente agora — o próximo turno o recria"
fi

echo "3. O guarda de destino recusa a rede de dentro?"
for alvo in "http://openbot:3001/api/admin/connectors" "http://127.0.0.1:5432"; do
  codigo=$(curl -sS -m 45 -o /dev/null -w "%{http_code}" -X POST \
    "$API/api/computers/$AGENTE/fetch" -H "content-type: application/json" \
    -d "{\"url\":\"$alvo\"}" 2>/dev/null)
  if [ "$codigo" = "403" ]; then
    aprovar "recusou $alvo"
  else
    reprovar "$alvo respondeu $codigo, e devia ser 403"
  fi
done

echo "4. Uma página pública ainda abre?"
titulo=$(curl -sS -m 60 -X POST "$API/api/computers/$AGENTE/fetch" \
  -H "content-type: application/json" -d '{"url":"https://example.com"}' 2>/dev/null)
case "$titulo" in
  *"Example Domain"*) aprovar "leu example.com" ;;
  *) reprovar "não leu example.com: ${titulo:0:120}" ;;
esac

echo "5. O Bot usa o navegador quando pedem uma página?"
# httpbin.org/uuid muda a cada leitura, então uma resposta certa não pode vir de memória.
resposta=$(curl -sS -N -m 200 -X POST "$API/api/copilotkit/agent/$AGENTE/run" \
  -H "content-type: application/json" \
  -d "{\"threadId\":\"smoke-$(date +%s)\",\"runId\":\"smoke\",\"messages\":[{\"id\":\"u1\",\"role\":\"user\",\"content\":\"Abra https://httpbin.org/uuid e diga o valor do campo uuid.\"}],\"tools\":[],\"context\":[],\"state\":{},\"forwardedProps\":{}}" 2>/dev/null)
case "$resposta" in
  *"Nenhuma página foi aberta"*) reprovar "o Bot respondeu de memória — ver AGENTS.md e as ferramentas" ;;
  *[0-9a-f]-[0-9a-f]*)           aprovar "abriu a página e leu o valor" ;;
  *)                             reprovar "resposta sem o valor pedido" ;;
esac

echo
if [ "$falhou" -ne 0 ]; then
  echo "SMOKE REPROVOU — não considere este deploy bom." >&2
  exit 1
fi
echo "SMOKE PASSOU."
