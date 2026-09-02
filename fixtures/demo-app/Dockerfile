# Three-way aligned demo SUT (SPEC T4). Build context is fixtures/demo-app,
# so the image stays fully self-contained.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY proto ./proto
COPY src ./src

EXPOSE 8080 9090
CMD ["node", "src/server.js"]
