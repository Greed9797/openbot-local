# Lightpanda: o motor sem pixels, para as páginas que ninguém assiste.
#
# Ubuntu 24.04 por causa da glibc, duas vezes.
#
# Musl está fora: os binários publicados são ligados à glibc e numa base Alpine o processo morre com
# "cannot execute: required file not found", que não parece um problema de libc. E o Debian bookworm,
# que a documentação sugere, traz a glibc 2.36 enquanto o binário exige a 2.38 — falha só ao
# executar, não ao baixar. Noble traz a 2.39, e é a mesma base da imagem principal.
FROM ubuntu:24.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Do canal nightly, que é o que o projeto publica hoje. Fixe uma release própria se quiser um build
# reproduzível: nightly muda debaixo de você.
#
# O arquivo é escolhido pela arquitetura de destino porque o projeto publica um por arquitetura e o
# binário errado não falha ao baixar — falha ao executar, com "Could not open ld-linux-x86-64.so.2",
# que não parece um problema de arquitetura para quem lê.
# Vazio por padrão porque só o BuildKit preenche TARGETARCH; no builder clássico a arquitetura vem
# do próprio Debian abaixo, que dá a mesma resposta para um build nativo.
ARG TARGETARCH=""
ARG LIGHTPANDA_RELEASE=nightly
RUN set -eu; \
  arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
  case "${arch}" in \
    amd64) file=lightpanda-x86_64-linux ;; \
    arm64) file=lightpanda-aarch64-linux ;; \
    *) echo "Sem binário do Lightpanda para ${arch}." >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /usr/local/bin/lightpanda \
    "https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_RELEASE}/${file}"; \
  chmod +x /usr/local/bin/lightpanda; \
  lightpanda version

# Um navegador não roda como root nesta casa. O noble já traz um uid 1000 chamado `ubuntu`, então
# criar outro esbarraria nele.
USER ubuntu

EXPOSE 9222

# `--host 0.0.0.0` para o agent-computer alcançar pela rede do compose; a porta continua sem
# publicação no host, então quem chega é só quem está nessa rede.
#
# `--obey-robots` fica ligado. Este motor existe para ler muitas páginas depressa, que é exatamente
# a forma de, sem querer, martelar o site de alguém.
CMD ["lightpanda", "serve", "--host", "0.0.0.0", "--port", "9222", "--obey-robots", "--log-level", "warn"]
