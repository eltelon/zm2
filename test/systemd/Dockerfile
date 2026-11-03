FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive container=docker \
    NVM_DIR=/opt/nvm ZM2_NODE_OLD=22.14.0 ZM2_NODE_TARGET=24.0.0 \
    CLI_NODE=/opt/nvm/versions/node/v22.14.0/bin/node \
    ZM2_HOME=/var/lib/zm2-test
ENV PATH=/opt/nvm/versions/node/v22.14.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus curl ca-certificates xz-utils procps iproute2 \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/nvm /var/lib/zm2-test /var/lib/zm2-evidence /var/log/journal \
    && chmod 700 /var/lib/zm2-test \
    && mkdir -p /etc/systemd/journald.conf.d \
    && printf '[Journal]\nStorage=persistent\n' > /etc/systemd/journald.conf.d/zm2-test.conf

# Pinned nvm source, SHA256 checked before extraction or sourcing.
RUN curl -fsSL https://codeload.github.com/nvm-sh/nvm/tar.gz/refs/tags/v0.40.3 -o /tmp/nvm.tar.gz \
    && echo '5f4d6aaa04a177dc93c985e31dbc411ab6b8c6e1e21d8015dbc1372625fcd1d0  /tmp/nvm.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/nvm.tar.gz --strip-components=1 -C /opt/nvm \
    && chmod -R go-w /opt/nvm \
    && rm /tmp/nvm.tar.gz

# Verify official per-release SHA256 manifests before installing both runtimes.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in arm64) arch=arm64 ;; amd64) arch=x64 ;; *) exit 1 ;; esac; \
    for version in "$ZM2_NODE_OLD" "$ZM2_NODE_TARGET"; do \
      file="node-v${version}-linux-${arch}.tar.xz"; \
      curl -fsSL "https://nodejs.org/dist/v${version}/$file" -o "/tmp/$file"; \
      curl -fsSL "https://nodejs.org/dist/v${version}/SHASUMS256.txt" -o /tmp/SHASUMS256.txt; \
      (cd /tmp && grep "  $file\$" SHASUMS256.txt | sha256sum -c -); \
      mkdir -p "/opt/nvm/versions/node/v$version"; \
      tar -xJf "/tmp/$file" --strip-components=1 -C "/opt/nvm/versions/node/v$version"; \
      "/opt/nvm/versions/node/v$version/bin/node" --version; \
      rm "/tmp/$file"; \
    done; \
    mkdir -p /opt/nvm/alias; printf '%s\n' "$ZM2_NODE_OLD" > /opt/nvm/alias/default

WORKDIR /opt/zm2
COPY package.json package-lock.json ./
# The inherited lock describes PM2 (29 dependencies vs 17 in this manifest).
# Preserve it, derive an image-only lock, then install exactly that generated lock.
RUN cp package-lock.json /var/lib/zm2-evidence/inherited-package-lock.json \
    && rm package-lock.json \
    && npm install --package-lock-only --ignore-scripts --omit=dev --no-audit --no-fund \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && cp package-lock.json /var/lib/zm2-evidence/installed-package-lock.json \
    && printf 'manifest-derived image-only lock; npm ci --omit=dev --ignore-scripts\n' > /var/lib/zm2-evidence/install-method.txt
COPY bin ./bin
COPY lib ./lib
COPY index.js constants.js paths.js ./
COPY test/fixtures ./test/fixtures
COPY test/e2e/systemd ./test/e2e/systemd
RUN cd test/fixtures/systemd-express && npm ci --ignore-scripts --no-audit --no-fund \
    && cp package-lock.json /var/lib/zm2-evidence/express-package-lock.json

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
