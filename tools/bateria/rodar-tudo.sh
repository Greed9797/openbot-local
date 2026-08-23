#!/usr/bin/env bash
# Roda as quatro listas de turno único e as conversas contra um Bot, e sai != 0 se alguma falhar.
#
# As conversas vêm por último e sem `--repete`: elas são caras (dezenas de turnos) e existem para
# medir o que a lista de turno único não alcança — o que o Bot ainda sabe na segunda pergunta.
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

echo "##### conversas"
python3 -u "$AQUI/conversa.py" "$AGENTE" "$AQUI/conversas.json" || falhou=1
echo

if [ "$falhou" -ne 0 ]; then
  echo "BATERIA REPROVOU" >&2
  exit 1
fi
echo "BATERIA PASSOU — o conteúdo das respostas ainda precisa de olho humano."
