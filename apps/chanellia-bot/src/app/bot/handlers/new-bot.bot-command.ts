import {Inject, Injectable, OnModuleInit} from '@nestjs/common';
import {Bot} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {CHANELLIA_BOT_INSTANCE} from '../providers/bot.provider';
import {Conversation, createConversation} from '@grammyjs/conversations';
import {BotsQueueService} from '@chanellia/common';
import {ClientsRepositoryService} from '../services/clients-repository.service';

@Injectable()
export class NewBotBotCommand implements OnModuleInit {
  constructor(
    @Inject(CHANELLIA_BOT_INSTANCE) private bot: Bot<BotContext>,
    private botsQueueService: BotsQueueService,
    private clientsRepositoryService: ClientsRepositoryService
  ) {
  }

  public onModuleInit(): void {
    this.bot.use(createConversation(this.addBotConversation.bind(this), 'addBotConversation'));

    this.bot.command('newbot', async (ctx: BotContext) => {
      await ctx.conversation.enter('addBotConversation');
    });
  }

  public async addBotConversation(
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

      const botInfo = await conversation.external(async () => {
        try {
          const bot = new Bot(botTokenCandidate);
          try {
            bot.start();
            bot.catch((error) => {
              console.error(error);
            });
          } catch (e) {
            return null;
          }
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

      const existedBot = await conversation.external(async () => {
        return await this.clientsRepositoryService.findClientByBotId(botInfo.id);
      });

      if (existedBot) {
        ctx.reply(
          'Такой бот уже добавлен, попробуй другой токен или нажми /cancel чтобы прекратить'
        );
        continue;
      }

      const clientEntity = await conversation.external(async () => {
        return this.clientsRepositoryService.createClient({
          adminUserId: answerCtx.from.id,
          botId: botInfo.id,
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
