# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:26.10.0-trixie-slim
ARG MISE_VERSION=2026.9.12

FROM ${NODE_IMAGE} AS package

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build \
 && npm run package:audit \
 && node -e '\
const runtime = require("./package.json").piHerdsman?.runtime; \
if (!runtime?.pi || !runtime.herdr?.version || !runtime.herdr?.sha256) \
  throw new Error("runtime metadata missing"); \
process.stdout.write(JSON.stringify(runtime));' > /runtime.json \
 && tarball="$(npm pack --ignore-scripts --silent)" \
 && mkdir /package \
 && tar -xzf "$tarball" -C /package --strip-components=1

FROM ghcr.io/jdx/mise:${MISE_VERSION} AS mise

FROM ${NODE_IMAGE}

ARG TARGETARCH
ARG MISE_VERSION

ENV LANG=C.UTF-8 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      dnsutils \
      fd-find \
      file \
      fzf \
      gh \
      git \
      git-lfs \
      iproute2 \
      jq \
      less \
      lsof \
      netcat-openbsd \
      openssh-client \
      openssh-server \
      pkg-config \
      procps \
      psmisc \
      python3 \
      python3-venv \
      ripgrep \
      rsync \
      sqlite3 \
      tree \
      unzip \
      util-linux \
      zip \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -f /etc/ssh/ssh_host_*

RUN groupmod -n herdsman node \
 && usermod -l herdsman -d /home/herdsman -m node \
 && passwd -d herdsman \
 && install -d -m 0755 /run/sshd \
 && install -d -m 0700 /var/lib/herdsman/ssh

RUN cat >> /etc/bash.bashrc <<'EOF'

# Open Herdr for direct interactive access. Herdr panes set HERDR_ENV=1.
if [ "$(id -un)" = herdsman ]; then
  export HOME=/home/herdsman
  export USER=herdsman
  export LOGNAME=herdsman
  export PATH=/home/herdsman/.local/share/mise/shims:/home/herdsman/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

  if [ -t 0 ] && [ -t 1 ] && [ "${HERDR_ENV:-}" != 1 ] && command -v herdr >/dev/null 2>&1; then
    herdr
  fi
fi
EOF

COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
COPY --from=package /runtime.json /tmp/runtime.json

RUN set -eu; \
    pi_version="$(node -p 'require("/tmp/runtime.json").pi')"; \
    case "$TARGETARCH" in \
      amd64) pi_arch=x64 ;; \
      arm64) pi_arch=arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    asset="pi-linux-${pi_arch}.tar.gz"; \
    release="https://github.com/earendil-works/pi/releases/download/v${pi_version}"; \
    curl -fsSL "$release/$asset" -o "/tmp/$asset"; \
    curl -fsSL "$release/SHA256SUMS" -o /tmp/SHA256SUMS; \
    (cd /tmp && grep -F "  $asset" SHA256SUMS | sha256sum -c -); \
    mkdir -p /opt/pi; \
    tar -xzf "/tmp/$asset" -C /opt/pi --strip-components=1; \
    ln -s /opt/pi/pi /usr/local/bin/pi; \
    test "$(pi --version)" = "$pi_version"; \
    rm -f /tmp/SHA256SUMS "/tmp/$asset"

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) herdr_arch=x86_64 ;; \
      arm64) herdr_arch=aarch64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    herdr_target="linux-${herdr_arch}"; \
    herdr_version="$(node -p 'require("/tmp/runtime.json").herdr.version')"; \
    herdr_sha256="$(node -p 'require("/tmp/runtime.json").herdr.sha256[process.argv[1]]' "$herdr_target")"; \
    curl -fsSL "https://github.com/herdrdev/herdr/releases/download/v${herdr_version}/herdr-linux-${herdr_arch}" -o /tmp/herdr; \
    printf '%s  %s\n' "$herdr_sha256" /tmp/herdr | sha256sum -c -; \
    install -m 0755 /tmp/herdr /usr/local/bin/herdr; \
    test "$(herdr --version | awk '{ print $NF }')" = "$herdr_version"; \
    rm -f /tmp/herdr

RUN set -eu; \
    mkdir -p /usr/share/doc/pi-herdsman/third-party; \
    pi_version="$(node -p 'require("/tmp/runtime.json").pi')"; \
    herdr_version="$(node -p 'require("/tmp/runtime.json").herdr.version')"; \
    curl -fsSL "https://raw.githubusercontent.com/earendil-works/pi/v${pi_version}/LICENSE" -o /usr/share/doc/pi-herdsman/third-party/pi-LICENSE; \
    curl -fsSL "https://raw.githubusercontent.com/herdrdev/herdr/v${herdr_version}/LICENSE" -o /usr/share/doc/pi-herdsman/third-party/herdr-LICENSE; \
    curl -fsSL "https://raw.githubusercontent.com/jdx/mise/v${MISE_VERSION}/LICENSE" -o /usr/share/doc/pi-herdsman/third-party/mise-LICENSE; \
    rm -f /tmp/runtime.json

COPY --from=package /package /opt/pi-herdsman
COPY --chmod=0444 docker/AGENTS.md /AGENTS.md
COPY docker/entrypoint.sh /usr/local/bin/container-entrypoint
COPY docker/sshd_config /etc/ssh/sshd_config

RUN chmod 0755 /usr/local/bin/container-entrypoint \
 && chmod 0600 /etc/ssh/sshd_config

WORKDIR /home/herdsman

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/container-entrypoint"]
