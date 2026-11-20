# Use the official compiled release, including its matching Node/native modules/UI.
FROM ghcr.io/openclaw/openclaw:2026.11.6

# Existing Railway volume was created by the root-based community template.
USER root
WORKDIR /opt/railway-wrapper

ENV NODE_ENV=production \
    OPENCLAW_ENTRY=/app/openclaw.mjs \
    OPENCLAW_NO_RESPAWN=1 \
    NPM_CONFIG_PREFIX=/data/npm \
    NPM_CONFIG_CACHE=/data/npm-cache \
    PNPM_HOME=/data/pnpm \
    PNPM_STORE_DIR=/data/pnpm-store
ENV PATH=/data/npm/bin:/data/pnpm:${PATH}

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --cache /tmp/wrapper-npm-cache \
    && rm -rf /tmp/wrapper-npm-cache
COPY src ./src

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||process.env.OPENCLAW_PUBLIC_PORT||3000)+"/readyz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "src/railway-start.mjs"]
