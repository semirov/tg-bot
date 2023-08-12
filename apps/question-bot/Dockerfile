FROM node:18 as builder
# Choose a workdir
WORKDIR /usr/src/app
COPY nx.json .
COPY package.json .
COPY tsconfig.base.json .
COPY package-lock.json .
RUN npm ci --max-old-space-size=4096

COPY apps/question-bot /usr/src/app/apps/question-bot

# Build app
RUN npm run build:question-bot

RUN npm prune --production

FROM node:18-alpine
ENV NODE_ENV=production

WORKDIR /usr/question-bot

COPY --from=builder /usr/src/app/node_modules /usr/question-bot/node_modules
COPY --from=builder /usr/src/app/dist/apps/question-bot /usr/question-bot/apps/question-bot


CMD ["node", "./apps/question-bot/main.js"]
EXPOSE 5353
