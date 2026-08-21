# The Codex Bot needs more than a runtime: its model IS a CLI, so the CLI is part of the image and
# the credential is mounted at run time rather than baked in. Debian rather than Alpine because the
# published Codex binaries are glibc builds.
FROM oven/bun:1.3-debian

# Node is not used to run this service. It is here because `codex` is distributed on npm and its
# launcher is a Node script.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git nodejs npm \
  && rm -rf /var/lib/apt/lists/*

# Pinned. An agent whose model silently changes version under a running deployment is not something
# anybody can debug; move this deliberately.
ARG CODEX_VERSION=0.148.0
RUN npm install -g @openai/codex@${CODEX_VERSION} && codex --version

WORKDIR /app
RUN chown bun:bun /app
USER bun
COPY --chown=bun:bun agent-codex/package.json ./agent-codex/
RUN cd agent-codex && bun install

# Preserve the repo layout so `../../shared/agent-authorisation` resolves the same in the image and
# locally.
COPY --chown=bun:bun shared ./shared
COPY --chown=bun:bun agent-codex/src ./agent-codex/src

# Both are volumes in compose. /state holds the credential and the thread map, /workspace is the only
# place the sandbox may write.
ENV PORT=4202 \
    CODEX_HOME=/state/codex-home \
    CODEX_STATE_DIR=/state/threads \
    CODEX_WORKSPACE=/workspace
EXPOSE 4202
CMD ["bun", "agent-codex/src/index.ts"]
