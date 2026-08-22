#!/usr/bin/env bash
# Roda as quatro listas contra um Bot e sai != 0 se alguma falhar.
#
# Do repositório, sem copiar arquivo nenhum. A primeira validação desta bateria abortou na quarta
# lista porque uma cópia manual não tinha chegado à VPS, e o loop deu por encerrado sem ter rodado
# um quarto das tarefas — sem erro visível, porque o Python morreu dentro de um `for` de shell.
#
#   bash tools/bateria/rodar-tudo.sh [agente] [--repete=N]
set -uo pipefail

AGENTE="${1:-risk-analyst}"
REPETE="${2:-}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

falhou=0
for lista in basicas dificeis adversariais workspace; do
  arquivo="$AQUI/tarefas-$lista.json"
  if [ ! -f "$arquivo" ]; then
    echo "FALTA a lista $lista em $arquivo" >&2
    falhou=1
    continue
  fi
  echo "##### $lista"
  python3 -u "$AQUI/bateria.py" "$AGENTE" "$arquivo" $REPETE || falhou=1
  echo
done

if [ "$falhou" -ne 0 ]; then
  echo "BATERIA REPROVOU" >&2
  exit 1
fi
echo "BATERIA PASSOU — o conteúdo das respostas ainda precisa de olho humano."
