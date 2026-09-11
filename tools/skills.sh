#!/usr/bin/env bash
#
# As skills da pessoa, dentro dos motores do Bot.
#
# O Bot não é uma conta: é um deployment com CLIs de agente, e cada CLI lê as skills do próprio
# diretório. Este script leva um diretório de skills até lá — o mesmo conteúdo nos dois motores — e
# fica fora do repositório de propósito: skill é dado de quem opera, não código do fork. Publicar
# as skills de alguém num push não é um acidente que se desfaça.
#
# Uso:
#   bash tools/skills.sh                     # instala ./skills
#   bash tools/skills.sh ~/camino/skills     # outro diretório
#   bash tools/skills.sh --limpar            # tira o que este script instalou
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
ORIGEM="./skills"

# Uma skill é uma pasta com SKILL.md dentro — é assim que os dois CLIs procuram, e é o que conta
# aqui. O resto do diretório pode ser qualquer coisa: referências, scripts, mapas.
contar() {
  find "$1" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l | tr -d ' '
}

if [ "${1:-}" = "--limpar" ]; then
  for i in "${!SERVICOS[@]}"; do
    servico="${SERVICOS[$i]}"
    destino="${DESTINOS[$i]}"
    cd "$(dirname "$0")/.."
    docker compose exec -T "$servico" sh -c "find '$destino' -mindepth 1 -maxdepth 1 ! -name '.system' -exec rm -rf {} +" &&
      echo "$servico: skills removidas de $destino"
  done
  exit 0
fi

[ -n "${1:-}" ] && ORIGEM="$1"

if [ ! -d "$ORIGEM" ]; then
  echo "não há '$ORIGEM' para instalar. Copie suas skills para lá (ou passe o caminho como argumento)." >&2
  exit 1
fi

instaladas=$(contar "$ORIGEM")
if [ "$instaladas" -eq 0 ]; then
  echo "'$ORIGEM' não tem nenhuma skill (uma pasta com SKILL.md dentro)." >&2
  exit 1
fi

echo "== instalando $instaladas skills de $ORIGEM"

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
  docker compose exec -T "$servico" sh -c "mkdir -p '$destino' && find '$destino' -mindepth 1 -maxdepth 1 ! -name '.system' -exec rm -rf {} +"
  docker compose cp "$ORIGEM/." "$servico:$destino"

  chegou=$(docker compose exec -T "$servico" sh -c "find '$destino' -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l" | tr -d ' \r')
  if [ "$chegou" != "$instaladas" ]; then
    echo "  $servico: chegaram $chegou de $instaladas skills em $destino — instalação incompleta." >&2
    exit 1
  fi
  echo "  $servico: $chegou skills em $destino"
done

echo
echo "Instalado nos dois motores. Uma conversa nova já enxerga; a que está aberta, não —"
echo "a lista de skills entra no começo do turno."
