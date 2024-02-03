import {Inject, Injectable} from '@nestjs/common';
import {Bot} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {CHANELLIA_BOT_INSTANCE} from '../providers/bot.provider';
import {Conversation, createConversation} from '@grammyjs/conversations';
import {BotsQueueService} from '@chanellia/common';
import {BotsRepositoryService} from '../services/bots-repository.service';
import {run} from "@grammyjs/runner";

@Injectable()
export class NewBotBotCommand {
  constructor(
    @Inject(CHANELLIA_BOT_INSTANCE) private bot: Bot<BotContext>,
    private botsQueueService: BotsQueueService,
    private botsRepositoryService: BotsRepositoryService
  ) {
  }

  public init(): void {
    this.bot.use(createConversation(this.addBotConversation.bind(this), 'addBotConversation'));

    this.bot.command('newbot', async (ctx: BotContext) => {
      const botsCount = await this.botsRepositoryService.botsCountByAdminId(ctx.from.id);
      if (botsCount >= 2) {
        return ctx.reply('Добавлено максимальное количество ботов');
      }

      await ctx.conversation.enter('addBotConversation');
    });
  }

  private async addBotConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    await ctx.reply(
      'Для того, чтобы подключить бота пришли его токен, создать бота можно c помощью @BotFather\n\nЕсли передумал, нажми /cancel'
    );


    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answerCtx = await conversation.wait();
      const botTokenCandidate = (answerCtx.message?.text || '').trim();
      if (botTokenCandidate === '/cancel') {
        await ctx.reply('Ок, не будем добавлять бота');
        return;
      }

      if (!/^[0-9]{8,10}:[a-zA-Z0-9_-]{35}$/.test(botTokenCandidate)) {
        await ctx.reply('Неверный формат токена, попробуй еще раз, если передумал, нажми /cancel');
        continue;
      }


      const existingClient = await conversation.external(async () => {
        try {
          return await this.botsRepositoryService.findClientByToken(botTokenCandidate);
        } catch (e) {
          console.log(e);
        }

      });

      if (existingClient) {
        ctx.reply(
          'Такой бот уже добавлен, попробуй другой токен или нажми /cancel чтобы прекратить'
        );
        continue;
      }


      const bot = await conversation.external(async () => {
        try {
          return new Bot(botTokenCandidate);
        } catch (e) {
          return null;
        }
      });

      const botRunner = await conversation.external(() => {
        return run(bot);
      });

      if (!bot) {
        ctx.reply(
          'Не удалось проверить бота, возможно токен с ошибкой, проверь и попробуй еще раз, или нажми /cancel чтобы прекратить'
        );
        continue;
      }

      const botInfo = await conversation.external(async () => {
        try {
          return await bot.api.getMe();
        } catch (e) {
          return null;
        }
      });

      if (!botInfo) {
        ctx.reply(
          'Не удалось проверить бота, возможно токен с ошибкой, проверь и попробуй еще раз, или нажми /cancel чтобы прекратить'
        );
        continue;
      }

      await conversation.external(async () => {
        botRunner.isRunning && await botRunner.stop();
      });

      const clientEntity = await conversation.external(async () => {
        return this.botsRepositoryService.createClient({
          user: {id: answerCtx.from.id},
          botId: botInfo.id,
          botUsername: botInfo.username,
          botToken: botTokenCandidate,
        });
      });

      await ctx.reply(`Добавили бота: ${botInfo.first_name} (@${botInfo.username})`);
      await this.botsQueueService.addBotToRunQueue(clientEntity);
      ctx.reply(
        `Бот будет считать тебя администратором, чтобы продолжить настройку напиши боту @${botInfo.username}`
      );
      return;
    }
  }
}
