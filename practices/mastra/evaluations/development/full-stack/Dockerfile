FROM node:24.19.0-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node . .
RUN --network=none npm run generate && npm run build:api && npm run build:web
USER node
CMD ["npm","run","start:api"]
