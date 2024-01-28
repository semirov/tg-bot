import * as process from 'process';

export default () => ({
  BOT_TOKEN: process.env.BOT_TOKEN,
  BOT_OWNER_ID: process.env.BOT_OWNER_ID,
  DATABASE_HOST: process.env.DATABASE_HOST,
  DATABASE_PORT: process.env.DATABASE_PORT,
  DATABASE_USERNAME: process.env.DATABASE_USERNAME,
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD,
  DATABASE_NAME: process.env.DATABASE_NAME,
});
