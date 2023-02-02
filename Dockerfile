FROM node:18 as builder
# Choose a workdir
WORKDIR /usr/src/app
COPY nx.json .
COPY package.json .
COPY tsconfig.base.json .
COPY package-lock.json .
RUN npm ci --max-old-space-size=4096

COPY apps/tg-bot /usr/src/app/apps/tg-bot

# Build app
RUN npm run build

RUN npm prune --production

FROM node:18-alpine
ENV NODE_ENV=production

WORKDIR /usr/tg-bot

COPY --from=builder /usr/src/app/node_modules /usr/tg-bot/node_modules
COPY --from=builder /usr/src/app/dist/apps/tg-bot /usr/tg-bot/apps/tg-bot


CMD ["node", "./apps/tg-bot/main.js"]
EXPOSE 5353
