# 只打包信令服务。Node 24 原生 strip TypeScript，所以镜像里没有构建步骤，也不装 tsc。
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/protocol.ts ./src/protocol.ts
COPY server/signal.ts ./server/signal.ts

USER node
EXPOSE 8787
CMD ["node", "server/signal.ts"]
