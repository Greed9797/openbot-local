#!/bin/sh
# O diretório de perfis, com o dono certo, antes de o navegador existir.
#
# Um volume nomeado nasce do root, e o Chromium deste deployment roda como pwuser. O primeiro
# `launchPersistentContext` num volume root-owned falha com EACCES e o Bot perde o navegador inteiro;
# foi esse o incidente que este script existe para impedir. O `chown` do Dockerfile só alcança o
# diretório da imagem: um volume que já existia com outro dono continua como estava, porque Docker não
# reescreve dono de volume em `up`.
#
# Roda como root, uma vez, antes de o computador subir. `computer/run` o executa com `sh` e falha a
# inicialização se isto falhar, em vez de deixar o container "healthy" com um navegador que não abre.
#
# O que ele NÃO faz: seguir symlink, atravessar outro filesystem, mudar modo de arquivo, apagar
# perfil, ou virar root para contornar um mount somente leitura. Se o chown não for possível, isto
# termina com código não-zero e a razão no stderr.
set -eu

profiles="${PROFILES_DIR:-/profiles}"

fail() {
  echo "profiles-init: $*" >&2
  exit 1
}

case "$profiles" in
  /*) ;;
  *) fail "PROFILES_DIR precisa ser um caminho absoluto, e veio '$profiles'." ;;
esac

[ "$profiles" != "/" ] || fail "PROFILES_DIR não pode ser a raiz do filesystem."

# Um symlink aqui moveria a travessia inteira — e todo chown — para fora do que o operador montou.
[ ! -L "$profiles" ] || fail "'$profiles' é um symlink; monte o diretório de verdade."

if [ ! -d "$profiles" ]; then
  mkdir -p "$profiles" || fail "não consegui criar '$profiles'."
fi

uid="$(id -u pwuser)" || fail "não existe usuário pwuser nesta imagem."
gid="$(id -g pwuser)" || fail "não existe grupo pwuser nesta imagem."

# -P: symlink não é atravessado. -xdev: um mount sob esta raiz não é tocado. Só o que diverge do dono
# esperado é alterado, e --no-dereference garante que um symlink seja corrigido nele mesmo, nunca no
# alvo. Modo e conteúdo ficam como estão: um perfil 0700 vira do pwuser, não vira 0777.
find -P "$profiles" -xdev \( ! -uid "$uid" -o ! -gid "$gid" \) \
  -exec chown --no-dereference "$uid:$gid" {} + ||
  fail "não consegui corrigir o dono de '$profiles'. Se o volume é somente leitura, ele precisa ser montado gravável."

# A prova é o pwuser escrevendo, não o código de saída do chown. Criação exclusiva, escrita e
# remoção: as três coisas que o Chromium faz ao abrir um perfil pela primeira vez.
probe="$profiles/.profiles-init-probe.$$"
trap 'rm -f "$probe"' EXIT INT TERM

setuidgid_bin="$(command -v s6-setuidgid 2>/dev/null || echo /command/s6-setuidgid)"
[ -x "$setuidgid_bin" ] || fail "s6-setuidgid indisponível; rode sob s6 ou com /command no PATH."
"$setuidgid_bin" pwuser sh -c '
  p="$1"
  set -C
  : > "$p" || exit 1
  printf ok >> "$p" || exit 1
  rm -f "$p" || exit 1
' sh "$probe" || fail "'$profiles' não está gravável para pwuser."

rm -f "$probe"
trap - EXIT INT TERM
