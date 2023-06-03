import * as process from "process";

export default () => ({
  BOT_TOKEN: process.env.BOT_TOKEN,
  BOT_OWNER_ID: process.env.BOT_OWNER_ID,
  MANAGED_CHANNEL: process.env.MANAGED_CHANNEL,
  USER_REQUEST_CHANNEL: process.env.USER_REQUEST_CHANNEL,
  OBSERVER_CHANNEL: process.env.USER_REQUEST_CHANNEL,
  CRINGE_CHANNEL: process.env.CRINGE_CHANNEL,
  DATABASE_HOST: process.env.DATABASE_HOST,
  DATABASE_PORT: process.env.DATABASE_PORT,
  DATABASE_USERNAME: process.env.DATABASE_USERNAME,
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD,
  DATABASE_NAME: process.env.DATABASE_NAME,
  APP_API_ID: process.env.APP_API_ID,
  APP_API_HASH: process.env.APP_API_HASH
});

