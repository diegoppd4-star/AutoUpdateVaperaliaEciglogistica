FROM node:22-bookworm

ARG CODEX_CLI_VERSION=0.149.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 python3-pip \
  && python3 -m pip install --no-cache-dir --break-system-packages "psycopg[binary]==3.2.9" \
  && npm install -g @openai/codex@${CODEX_CLI_VERSION} \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY scraper/package*.json ./scraper/
RUN cd scraper \
  && npm ci \
  && npx playwright install --with-deps chromium

COPY . .
RUN cd /app/scraper \
  && npm run build \
  && chmod -R a+rwX /app/scraper/dist \
  && chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production
ENV CODEX_EXEC_PATH=codex

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["--run-name", "docker-full-refresh"]
