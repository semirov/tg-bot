import * as process from 'process';

export default () => ({
  BOT_TOKEN: process.env.CM_BOT_TOKEN,
  BOT_OWNER_ID: process.env.CM_BOT_OWNER_ID,
  DATABASE_HOST: process.env.CM_DATABASE_HOST,
  DATABASE_PORT: process.env.CM_DATABASE_PORT,
  DATABASE_USERNAME: process.env.CM_DATABASE_USERNAME,
  DATABASE_PASSWORD: process.env.CM_DATABASE_PASSWORD,
  DATABASE_NAME: process.env.CM_DATABASE_NAME,
});
