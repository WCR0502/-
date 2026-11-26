# 同频 MedEcho · 生产镜像
# 说明：数据库改用 Node 22 内置的 node:sqlite，不再需要 better-sqlite3，
# 因此这个镜像不需要 python3/make/g++，构建更快、体积更小。
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=5173
WORKDIR /app

# 只复制运行必需的东西：源码、静态资源、演示数据
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public
COPY data/exam-fees.demo.json ./data/exam-fees.demo.json

# 非 root 运行；数据库目录需要可写
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 启动前先迁移，避免容器起来后才报缺表
CMD ["sh", "-c", "node scripts/migrate.js && node server.js"]
