#!/usr/bin/env bash
# O que roda sozinho, para a degradação não esperar alguém desconfiar.
#
# O defeito mais caro deste fork degradava com o uso: o Bot apagava as próprias instruções mexendo no
# workspace e voltava a responder de memória. Ficou horas assim, respondendo bem, e só apareceu
# porque alguém resolveu rodar a bateria. Um sistema cujo modo de falha é "continua respondendo" não
# pode depender de desconfiança humana.
#
#   bash tools/monitorar.sh smoke     # ~1 min, para rodar de hora em hora
#   bash tools/monitorar.sh bateria   # ~25 min, para rodar uma vez por dia
#   bash tools/monitorar.sh carga     # ~5s, para rodar a cada 5 min: load e disco antes do throttle
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
MODO="${1:-smoke}"
REGISTRO="/opt/openbot-local/logs"
mkdir -p "$REGISTRO"

quando=$(date "+%Y-%m-%d %H:%M")
arquivo="$REGISTRO/$MODO.log"

case "$MODO" in
    smoke)   saida=$(bash tools/smoke-deployment.sh 2>&1); estado=$? ;;
    bateria) saida=$(bash tools/bateria/rodar-tudo.sh 2>&1); estado=$? ;;
    carga)
      # Limites que antecedem o corte da Hostinger: load 6 = 1.5x os 4 vCPU; disco 80% foi o
      # patamar medido antes do apagão (82%). Falhar aqui é aviso, não defeito — o cron registra
      # SOBRECARGA no log e alguém olha antes do throttle.
      carga1=$(awk '{print $1}' /proc/loadavg)
      uso_disco=$(df -P / | awk 'NR==2 {gsub(/%/, ""); print $5}')
      saida="load1=$carga1 disco=${uso_disco}%"
      estado=0
      # awk para decimal: load pode ser 6.5, e [ ... -gt ] não compara ponto flutuante.
      if awk "BEGIN {exit !($carga1 > 6.0)}"; then
        saida="$saida SOBRECARGA-DE-CPU (limite 6.0)"
        estado=1
      fi
      if [ "$uso_disco" -gt 80 ]; then
        saida="$saida SOBRECARGA-DE-DISCO (limite 80%)"
        estado=1
      fi
      ;;
    *)       echo "modo desconhecido: $MODO" >&2; exit 2 ;;
esac

if [ "$estado" -eq 0 ]; then
  echo "$quando  ok" >> "$arquivo"
else
  # A saída inteira só quando falha. Um log que guarda tudo vira um log que ninguém abre.
  {
    echo "$quando  REPROVOU"
    echo "$saida" | sed "s/^/    /"
    echo
  } >> "$arquivo"
fi

# Sem rotação vira um arquivo de um giga em seis meses, e aí alguém apaga o log inteiro.
tail -n 2000 "$arquivo" > "$arquivo.tmp" && mv "$arquivo.tmp" "$arquivo"
exit "$estado"
