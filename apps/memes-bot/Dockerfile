# syntax=docker/dockerfile:1.7
# Production-образ приложения. Собирается FROM базового образа с зависимостями
# (Dockerfile.deps), поэтому на каждый билд копируется и собирается только код.
#
# ARG DEPS_IMAGE задаёт базовый образ (тег = хэш package-lock.json).
ARG DEPS_IMAGE=cr.yandex/crp8g8jm3p8d780a8hk3/telegram-bot-deps:latest

FROM ${DEPS_IMAGE} as builder
WORKDIR /usr/src/app
COPY nx.json tsconfig.base.json ./
COPY apps/memes-bot /usr/src/app/apps/memes-bot

# Build app
RUN npm run build:memes-bot

RUN npm prune --production

FROM node:20-alpine
ENV NODE_ENV=production

WORKDIR /usr/memes-bot

COPY --from=builder /usr/src/app/node_modules /usr/memes-bot/node_modules
COPY --from=builder /usr/src/app/dist/apps/memes-bot /usr/memes-bot/apps/memes-bot

CMD ["node", "./apps/memes-bot/main.js"]
EXPOSE 5353
