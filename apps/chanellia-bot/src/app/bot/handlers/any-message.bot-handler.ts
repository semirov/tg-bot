import {Inject, Injectable} from '@nestjs/common';
import {Bot} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {CHANELLIA_BOT_INSTANCE} from '../providers/bot.provider';
import {ManagedBotService} from '../services/managed-bot.service';
import {BotsRepositoryService} from '../services/bots-repository.service';
import {BaseConfigService} from '../../config/base-config.service';

@Injectable()
export class AnyMessageBotHandler {
  constructor(
    @Inject(CHANELLIA_BOT_INSTANCE) private bot: Bot<BotContext>,
    private managedBotService: ManagedBotService,
    private clientsRepositoryService: BotsRepositoryService,
    private config: BaseConfigService
  ) {
  }

  public init(): void {
    // только приватные каналы
    const pm = this.bot.chatType('private');

    // пересылка всех сообщений от пользователей в бот
    pm.filter((ctx) => ctx.from.id !== this.config.ownerId).on('message', async (ctx) => {
      const userMessage = ctx.from;
      const forwardMessage = ctx.forwardMessage(this.config.ownerId);
    });

    // отправка ответов пользователям
    pm.filter((ctx) => ctx.from.id === this.config.ownerId && !!ctx?.message?.reply_to_message).on(
      'message',
      (ctx) => {
        const replyMessage = ctx.message.reply_to_message;
        ctx.copyMessage(replyMessage.chat.id);
        // this.bot.api.setMessageReaction(ctx.message.chat.id, replyMessage.message_id, '👍' as any);
      }
    );
  }
}
