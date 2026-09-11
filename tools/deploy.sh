#!/usr/bin/env bash
# Sobe o que mudou e confere que o deployment continua sendo o que se espera dele.
#
# `docker compose up -d` sai com zero assim que o container inicia, e é aí que mora o problema deste
# fork inteiro: um Bot sem ferramentas inicia, atende e conversa; um guarda de destino desligado
# inicia e devolve páginas. Todos os defeitos sérios daqui foram descobertos horas depois do deploy
# que os introduziu, por alguém olhando uma resposta estranha.
#
# O sync é daqui, não é passo manual antes. Duas vezes o `git pull` feito à mão falhou sem ninguém
# ver — uma por branch errada, outra por arquivo não rastreado no caminho — e este script reconstruiu
# o código velho, o smoke passou (ele prova capacidade, não versão) e o erro só apareceu comparando
# hash à mão. Então, sem --local: fetch falho é fatal, avanço que não seja rápido é recusado, e o
# build só começa se o HEAD for exatamente o commit esperado. O resultado do smoke nomeia o commit
# que subiu, porque "passou" sobre código velho vale menos que nada.
#
#   bash tools/deploy.sh                      # busca a origin, atualiza, sobe tudo
#   bash tools/deploy.sh agent-codex          # idem, um serviço
#   bash tools/deploy.sh --local agent-codex  # reconstrói o commit de pé, sem falar com a origin
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

SERVICOS=()
SEM_SYNC=0
for arg in "$@"; do
  case "$arg" in
    --local) SEM_SYNC=1 ;;
    *) SERVICOS+=("$arg") ;;
  esac
done
[ ${#SERVICOS[@]} -eq 0 ] && SERVICOS=(openbot agent-codex agent-cli)

recusar() {
  echo >&2
  echo "Deploy recusado antes de construir qualquer coisa: $1" >&2
  echo "Nada foi derrubado nem construído. Corrija aí em cima e rode de novo." >&2
  exit 1
}

echo "== código"
ANTES=$(git rev-parse HEAD)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo >&2
  git status --porcelain >&2
  recusar "o clone tem mudança rastreada não commitada (lista acima). O build empacota a árvore \
como ela está, então o que subir não seria commit nenhum — commite e mande para a origin, ou \
desfaça."
fi
if [ "$SEM_SYNC" -eq 0 ]; then
  if ! git fetch origin; then
    recusar "não consegui falar com a origin. Construir agora seria construir o que já há aqui \
achando que é o que está lá (--local pula esta etapa de propósito)."
  fi

  ESPERADO=$(git rev-parse --verify --quiet '@{upstream}') ||
    recusar "a branch $(git rev-parse --abbrev-ref HEAD) não tem upstream — provavelmente é a \
branch errada."

  if ! git merge --ff-only "$ESPERADO"; then
    echo >&2
    git status --porcelain | head -20 >&2
    recusar "avançar até $(git log -1 --format='%h %s' "$ESPERADO") não deu. Ou há arquivo local \
no caminho (lista acima), ou a branch divergiu da upstream. Foi exatamente este o caminho que já \
subiu código velho duas vezes."
  fi
fi

DEPOIS=$(git rev-parse HEAD)
if [ "$SEM_SYNC" -eq 0 ] && [ "$DEPOIS" != "$ESPERADO" ]; then
  recusar "o HEAD (${DEPOIS:0:12}) não ficou no commit esperado (${ESPERADO:0:12})."
fi

SUBINDO=$(git log -1 --format='%h %s' HEAD)
if [ "$DEPOIS" = "$ANTES" ]; then
  echo "sem novidade: continuando no $SUBINDO"
else
  echo "subindo $SUBINDO"
fi

echo
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
  echo "Volte com: git checkout $ANTES && bash tools/deploy.sh --local" >&2
  exit 1
fi

echo
echo "SMOKE PASSOU no $SUBINDO."
echo "Para a validação inteira: bash tools/bateria/rodar-tudo.sh"
