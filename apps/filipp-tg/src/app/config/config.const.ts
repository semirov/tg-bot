import * as process from "process";

export default () => ({
  MEMES_BOT_TOKEN: process.env.MEMES_BOT_TOKEN,
  ADMIN_IDS: process.env.ADMIN_IDS,
  MODERATOR_IDS: process.env.MODERATOR_IDS,
  MEMES_CHANNEL: process.env.MEMES_CHANNEL,
  TEST_MEMES_CHANNEL: process.env.TEST_MEMES_CHANNEL,
});

