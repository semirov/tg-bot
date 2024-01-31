import {Inject, Injectable, OnModuleInit} from '@nestjs/common';
import {Bot} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {LIGHT_HOUSE_BOT} from '../providers/bot.provider';
import {Conversation, createConversation} from '@grammyjs/conversations';
import {InjectRepository} from '@nestjs/typeorm';
import {ClientEntity} from '../entities/client.entity';
import {Repository} from 'typeorm';
import {BotsQueueService} from "@chanellia/common";

@Injectable()
export class NewBotCommandHandler implements OnModuleInit {
  constructor(
    @Inject(LIGHT_HOUSE_BOT) private bot: Bot<BotContext>,
    @InjectRepository(ClientEntity) private clientRepository: Repository<ClientEntity>,
    private botsQueueService: BotsQueueService
  ) {
  }

  public onModuleInit(): void {
    this.bot.use(createConversation(this.addBotConversation.bind(this), 'addBotConversation'));

    this.bot.command('add_bot', async (ctx: BotContext) => {
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
        return await this.clientRepository.findOne({where: {botId: botInfo.id}});
      });

      if (existedBot) {
        ctx.reply(
          'Такой бот уже добавлен, попробуй другой токен или нажми /cancel чтобы прекратить'
        );
        continue;
      }

      const clientEntity = await conversation.external(async () => {
        const client = this.clientRepository.create({
          adminUserId: answerCtx.from.id,
          botId: botInfo.id,
          botToken: botTokenCandidate,
        });
        return await this.clientRepository.save(client);
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
