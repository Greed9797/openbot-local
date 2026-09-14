# O modelo deste serviço É um CLI, então o CLI faz parte da imagem; a conta entra em tempo de
# execução, nunca assada aqui.
#
# Debian, como a imagem do Codex, porque os dois CLIs publicam binários glibc.
FROM oven/bun:1.3-debian

# Node não roda este serviço: ele existe porque o CLI é distribuído no npm e o launcher dele é um
# script Node. `unzip` e `curl` são do instalador do OpenCode.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git nodejs npm curl unzip \
  && rm -rf /var/lib/apt/lists/*

# Fixados, e por um motivo diferente do Codex: aqui não é o modelo que muda de versão, é o *formato
# do --format json* e o nome da flag de auto-aprovação. Uma subida silenciosa de versão quebraria a
# leitura dos eventos sem quebrar nada visível — o turno terminaria "sem dizer nada".
ARG OPENCODE_VERSION=1.18.30
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
  && opencode --version

WORKDIR /app
RUN chown bun:bun /app
USER bun
COPY --chown=bun:bun agent-cli/package.json ./agent-cli/
RUN cd agent-cli && bun install

# O mesmo `mcp-computer` que o serviço do Codex usa: o navegador do Bot é um só, e o caminho do
# repo é preservado para que `../../shared/...` resolva igual aqui e na máquina de quem desenvolve.
COPY --chown=bun:bun shared ./shared
COPY --chown=bun:bun agent-cli/src ./agent-cli/src

# Criados na imagem, e não deixados para o volume: o Docker semeia um volume vazio a partir do que a
# imagem tem no caminho, dono incluído. Sem isto, o `HOME` do CLI nasce de root e o processo não
# consegue gravar nem a própria sessão.
USER root
RUN mkdir -p /state/home /workspace \
  && chown -R bun:bun /state /workspace
USER bun

# `HOME` é volume porque guarda a credencial e as sessões do CLI: sobrevive a um rebuild, e é o que
# faz o segundo turno lembrar do primeiro. `/workspace` é onde o Bot escreve o que a pessoa recebe.
ENV PORT=4210 \
    HOME=/state/home \
    XDG_DATA_HOME=/state/home/.local/share \
    AGENT_CLI_WORKSPACE=/workspace
EXPOSE 4210
CMD ["bun", "agent-cli/src/index.ts"]
