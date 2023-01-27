FROM node:18 as builder
# Choose a workdir
WORKDIR /usr/src/app
COPY nx.json .
COPY package.json .
COPY tsconfig.base.json .
COPY package-lock.json .
RUN npm ci --max-old-space-size=4096

COPY apps/filipp-tg /usr/src/app/apps/filipp-tg

# Build app
RUN npm run build

RUN npm prune --production

FROM node:18-alpine
ENV NODE_ENV=production

WORKDIR /usr/filipp-tg

COPY --from=builder /usr/src/app/node_modules /usr/filipp-tg/node_modules
COPY --from=builder /usr/src/app/dist/apps/filipp-tg /usr/filipp-tg/apps/filipp-tg


CMD ["node", "./apps/filipp-tg/main.js"]
EXPOSE 5353
