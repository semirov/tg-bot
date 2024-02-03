import {Inject, Injectable} from '@nestjs/common';
import {Bot} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {CHANELLIA_BOT_INSTANCE} from '../providers/bot.provider';
import {ManagedBotService} from '../services/managed-bot.service';
import {BotsRepositoryService} from '../services/bots-repository.service';
import {BaseConfigService} from '../../config/base-config.service';
import {InjectRepository} from '@nestjs/typeorm';
import {MessageEntity} from '../entities/message.entity';
import {Repository} from 'typeorm';
import {UserEntity} from '../entities/user.entity';

@Injectable()
export class AnyMessageBotHandler {
  constructor(
    @Inject(CHANELLIA_BOT_INSTANCE) private bot: Bot<BotContext>,
    private managedBotService: ManagedBotService,
    private clientsRepositoryService: BotsRepositoryService,
    private config: BaseConfigService,
    @InjectRepository(MessageEntity) private messagesRepository: Repository<MessageEntity>,
    @InjectRepository(UserEntity) private userRepository: Repository<UserEntity>
  ) {
  }

  public init(): void {
    // только приватные каналы
    const pm = this.bot.chatType('private');

    // пересылка всех сообщений от пользователей в бот
    pm.filter((ctx) => ctx.from.id !== this.config.ownerId).on('message', async (ctx) => {
      const forwardMessage = await ctx.forwardMessage(this.config.ownerId);

      await this.messagesRepository.insert({
        userChatId: ctx.from.id,
        userMessageId: ctx.message.message_id,
        botMessageId: forwardMessage.message_id,
      });
    });

    // отправка ответов пользователям
    pm.filter((ctx) => ctx.from.id === this.config.ownerId && !!ctx?.message?.reply_to_message).on(
      ['message'],
      async (ctx) => {
        const replyMessage = ctx.message.reply_to_message;
        const messageMetadata = await this.messagesRepository.findOne({
          where: {botMessageId: replyMessage.message_id},
        });

        const isHandled = await this.handleSpecificCommand(ctx, messageMetadata);
        if (isHandled) {
          return;
        }

        try {
          await this.bot.api.copyMessage(
            messageMetadata.userChatId,
            ctx.chat.id,
            ctx.message.message_id,
            {
              reply_to_message_id: messageMetadata.userMessageId,
            }
          );
        } catch (e) {
          console.log(e);
        }
      }
    );
  }

  private async handleSpecificCommand(
    ctx: BotContext,
    messageMetadata: MessageEntity
  ): Promise<boolean> {
    const preparedText = (ctx?.message?.text || '').toLowerCase().trim();

    switch (preparedText) {
      case 'бан':
        await this.banUser(ctx, messageMetadata);
        return true;
      default:
        return false;
    }
  }

  private async banUser(ctx: BotContext, messageMetadata: MessageEntity): Promise<void> {
    await this.bot.api.sendMessage(
      messageMetadata.userChatId,
      'Тебе ограничен доступ к боту, больше он не будет реагировать на сообщения'
    );
    ctx.reply('Пользователь заблокирован', {reply_to_message_id: ctx.message.message_id});
    await this.userRepository.update({id: messageMetadata.userChatId}, {banned: true});
  }
}
