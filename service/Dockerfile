# Slim, and pinned to a major. A verdict host that silently changes Node under
# itself is the same class of drift this project exists to catch.
FROM node:22-slim

WORKDIR /app

# The renderer comes from the tarball built out of this repository rather than
# from the registry. It keeps the deployed page identical to the one `--html`
# writes locally, and it means deploying never waits on a publish.
COPY package.json vendor/stantal.tgz ./
RUN npm install --omit=dev --no-audit --no-fund ./stantal.tgz && rm stantal.tgz

COPY server.mjs landing.html ./

ENV PORT=8080
EXPOSE 8080

# Not root. The process reads a request and writes to a bucket; nothing else.
USER node

CMD ["node", "server.mjs"]
