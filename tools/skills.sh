#!/usr/bin/env bash
#
# As skills da pessoa, dentro dos motores do Bot.
#
# O Bot não é uma conta: é um deployment com CLIs de agente, e cada CLI lê as skills do próprio
# diretório. Este script leva catálogos de skills até lá — todos os que forem passados, virados num
# só — e fica fora do repositório de propósito: skill é dado de quem opera, não código do fork.
# Publicar as skills de alguém num push não é um acidente que se desfaça.
#
# Uso:
#   bash tools/skills.sh                                  # instala ./skills
#   bash tools/skills.sh skills skills-agents skills-claude
#   bash tools/skills.sh --limpar                         # tira o que este script instalou
#
# Vários catálogos: uma skill é uma pasta com SKILL.md dentro, e o mesmo nome pode existir em mais
# de um catálogo com conteúdo diferente. Vence o catálogo citado primeiro — a ordem do comando é a
# ordem de prioridade — e o script diz quais nomes colidiram, para ninguém descobrir isso pela
# resposta do modelo.
#
# Onde cada motor lê (é o que este script preenche):
#   Codex    -> /state/codex-home/skills/<nome>/SKILL.md            (volume codex-state)
#   OpenCode -> /state/home/.config/opencode/skills/<nome>/SKILL.md (volume agent-cli-state)
#
# O que NÃO entra: `.system` e o cache de plugins da conta. O serviço do Codex apaga os dois a cada
# boot, de propósito e com motivo medido (ver `limparBagagemDaConta` em agent-codex/src/index.ts):
# são catálogos de ferramentas que nada têm a ver com dirigir navegador, e o Bot já gastou turno
# abrindo um SKILL.md de plugin no lugar de responder sobre a página.
set -euo pipefail

cd "$(dirname "$0")/.."

SERVICOS=(agent-codex agent-cli)
DESTINOS=(
  "/state/codex-home/skills"
  "/state/home/.config/opencode/skills"
)

limpar() {
  for i in "${!SERVICOS[@]}"; do
    docker compose exec -T "${SERVICOS[$i]}" sh -c \
      "find '${DESTINOS[$i]}' -mindepth 1 -maxdepth 1 ! -name '.system' -exec rm -rf {} +" &&
      echo "${SERVICOS[$i]}: skills removidas de ${DESTINOS[$i]}"
  done
}

if [ "${1:-}" = "--limpar" ]; then
  limpar
  exit 0
fi

ORIGENS=("$@")
[ ${#ORIGENS[@]} -eq 0 ] && ORIGENS=("./skills")

for origem in "${ORIGENS[@]}"; do
  [ -d "$origem" ] || { echo "não há '$origem' para instalar." >&2; exit 1; }
done

ESTAGIO=$(mktemp -d)
trap 'rm -rf "$ESTAGIO"' EXIT

# Um diretório por nome de skill, com a cópia mais recente dentro.
colisoes=0
for origem in "${ORIGENS[@]}"; do
  # `-L` porque skill pode ser link simbólico (para ~/.claude/skills, por exemplo): copiar o link
  # sem seguir deixa um link quebrado, e o motor lista a skill enquanto o modelo não acha o
  # SKILL.md — a falha que parece do modelo.
  while IFS= read -r -d '' arquivo; do
    nome=$(basename "$(dirname "$arquivo")")
    destino="$ESTAGIO/$nome"
    if [ -e "$destino/SKILL.md" ]; then
      echo "  colisão: $nome — ficou a de $origem (a ordem do comando é a prioridade)"
      colisoes=$((colisoes + 1))
      continue
    fi
    cp -RL "$(dirname "$arquivo")" "$destino"
  done < <(find "$origem" -mindepth 2 -maxdepth 2 -name SKILL.md -not -path '*/.system/*' -print0)
done

# Permissão de leitura para todo mundo: dentro do container quem lê é o usuário do CLI, que não é
# quem copiou, e uma skill em 0700 é uma skill que existe e não abre.
chmod -R a+rX "$ESTAGIO"

instaladas=$(find "$ESTAGIO" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')
if [ "$instaladas" -eq 0 ]; then
  echo "nenhuma skill nos catálogos informados (uma skill é uma pasta com SKILL.md dentro)." >&2
  exit 1
fi

echo "== instalando $instaladas skills de ${#ORIGENS[@]} catálogo(s), $colisoes colisões resolvidas"

for i in "${!SERVICOS[@]}"; do
  servico="${SERVICOS[$i]}"
  destino="${DESTINOS[$i]}"

  estado=$(docker compose ps --format '{{.State}}' "$servico" 2>/dev/null || echo "")
  if [ "$estado" != "running" ]; then
    echo "  $servico: não está de pé (estado: ${estado:-ausente}) — suba antes de instalar as skills." >&2
    exit 1
  fi

  # As skills antigas saem antes: skill renomeada que fica para trás é uma skill que o modelo ainda
  # enxerga e a pessoa não.
  docker compose exec -T "$servico" sh -c \
    "mkdir -p '$destino' && find '$destino' -mindepth 1 -maxdepth 1 ! -name '.system' -exec rm -rf {} +"
  docker compose cp "$ESTAGIO/." "$servico:$destino"

  chegou=$(docker compose exec -T "$servico" sh -c "find '$destino' -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l" | tr -d ' \r')
  if [ "$chegou" != "$instaladas" ]; then
    echo "  $servico: chegaram $chegou de $instaladas skills em $destino — instalação incompleta." >&2
    exit 1
  fi
  echo "  $servico: $chegou skills em $destino"
done

# O catálogo entra no começo de cada turno (nome + descrição de cada skill). Não é de graça, e o
# número é a única forma de decidir com informação se vale manter tudo.
peso=$(find "$ESTAGIO" -mindepth 2 -maxdepth 2 -name SKILL.md -exec sh -c 'grep -m1 "^name:" "$1"; grep -m1 "^description:" "$1"' _ {} \; | wc -c | tr -d ' ')
echo
echo "Catálogo: ~$((peso / 4)) tokens por turno (nome e descrição das $instaladas skills)."
echo "Conversa nova já enxerga; a que está aberta, não — a lista entra no começo do turno."
