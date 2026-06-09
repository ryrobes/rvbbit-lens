FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV HOME=/data
ENV RVBBIT_LENS_HOME=/data
ENV RVBBIT_LOCAL_WORK_ROOT=/data
ENV RVBBIT_CAPABILITY_ROOT=/usr/share/rvbbit/capabilities
ENV RVBBIT_CAPABILITY_CLI=/usr/share/rvbbit/capabilities/tools/rvbbit-capability

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        gosu \
        python3 \
        python3-yaml \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        docker-ce-cli \
        docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home-dir /data nextjs \
    && install -d -o nextjs -g nodejs -m 0700 /data \
    && install -d -m 0755 /usr/share/rvbbit/capabilities

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs rvbbit-capabilities/ /usr/share/rvbbit/capabilities/
COPY docker-entrypoint.sh /usr/local/bin/rvbbit-lens-entrypoint

RUN chmod 0755 /usr/local/bin/rvbbit-lens-entrypoint

EXPOSE 3000
ENTRYPOINT ["rvbbit-lens-entrypoint"]
CMD ["node", "server.js"]
