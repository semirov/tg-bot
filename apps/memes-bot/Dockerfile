FROM node:18 as builder
# Choose a workdir
WORKDIR /usr/src/app
COPY nx.json .
COPY package.json .
COPY tsconfig.base.json .
COPY package-lock.json .
RUN npm ci --max-old-space-size=4096

COPY apps/memes-bot /usr/src/app/apps/memes-bot

# Build app
RUN npm run build:memes-bot

RUN npm prune --production

FROM node:18-alpine
ENV NODE_ENV=production

WORKDIR /usr/memes-bot

COPY --from=builder /usr/src/app/node_modules /usr/memes-bot/node_modules
COPY --from=builder /usr/src/app/dist/apps/memes-bot /usr/memes-bot/apps/memes-bot


CMD ["node", "./apps/memes-bot/main.js"]
EXPOSE 5353
