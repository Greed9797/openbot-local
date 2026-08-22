#!/usr/bin/env bash
# Sobe o que mudou e conferе que o deployment continua sendo o que se espera dele.
#
# `docker compose up -d` sai com zero assim que o container inicia, e é aí que mora o problema deste
# fork inteiro: um Bot sem ferramentas inicia, atende e conversa; um guarda de destino desligado
# inicia e devolve páginas. Todos os defeitos sérios daqui foram descobertos horas depois do deploy
# que os introduziu, por alguém olhando uma resposta estranha.
#
#   bash tools/deploy.sh                    # tudo
#   bash tools/deploy.sh agent-codex        # um serviço
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
SERVICOS=("$@")
[ ${#SERVICOS[@]} -eq 0 ] && SERVICOS=(openbot agent-codex)

echo "== antes: o que está de pé"
docker compose ps --format "{{.Service}} {{.Status}}"

echo
echo "== build e sobe: ${SERVICOS[*]}"
docker compose build "${SERVICOS[@]}" || { echo "build falhou" >&2; exit 1; }
docker compose up -d "${SERVICOS[@]}" || { echo "up falhou" >&2; exit 1; }

echo
echo "== esperando ficar saudável"
# O healthcheck do agent-codex só passa quando as ferramentas subiram, então esperar por ele é
# esperar pela capacidade, e não só pelo processo.
for _ in $(seq 1 30); do
  pendentes=$(docker compose ps --format "{{.Service}} {{.Status}}" |
    grep -cE "starting|unhealthy" || true)
  [ "$pendentes" -eq 0 ] && break
  sleep 5
done
docker compose ps --format "{{.Service}} {{.Status}}"

echo
echo "== smoke"
if ! bash tools/smoke-deployment.sh; then
  echo >&2
  echo "O deploy subiu e NÃO passou no smoke. O serviço está no ar respondendo," >&2
  echo "que é exatamente como este fork escondeu os defeitos dele até agora." >&2
  echo "Volte com: git checkout <commit anterior> && bash tools/deploy.sh" >&2
  exit 1
fi

echo
echo "Deploy conferido. Para a validação inteira: bash tools/bateria/rodar-tudo.sh"
