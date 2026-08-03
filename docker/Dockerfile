# syntax=docker/dockerfile:1
FROM node:22-bookworm

ARG TARGETARCH
ARG FOUNDRY_VERSION=v1.3.1
ARG CODEX_VERSION=0.144.6
ARG CLAUDE_CODE_VERSION=2.1.220
ARG OPENCODE_VERSION=1.18.4
ARG TSX_VERSION=4.20.6

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
      amd64) foundry_arch=amd64 ;; \
      arm64) foundry_arch=arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${foundry_arch}.tar.gz" \
      | tar -xz -C /usr/local/bin forge cast anvil chisel

RUN npm install --global \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
      "tsx@${TSX_VERSION}" \
    && npm cache clean --force

RUN mkdir -p /arena /work /creds \
    && chown -R node:node /arena /work /creds
COPY --chown=node:node runner.mjs /arena/runner.mjs

USER node
WORKDIR /work
ENTRYPOINT ["node", "/arena/runner.mjs"]
