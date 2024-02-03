import {Inject, Injectable} from '@nestjs/common';
import {Bot, ChatTypeContext, Composer} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {CHANELLIA_BOT_INSTANCE} from '../providers/bot.provider';
import {ManagedBotService} from '../services/managed-bot.service';
import {BotsRepositoryService} from '../services/bots-repository.service';
import {BaseConfigService} from '../../config/base-config.service';
import {InjectRepository} from '@nestjs/typeorm';
import {MessageEntity} from '../entities/message.entity';
import {Repository} from 'typeorm';
import {UserEntity} from '../entities/user.entity';
import {Conversation, createConversation} from '@grammyjs/conversations';
import {CommonService} from '../services/common.service';

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
    this.bot.use(
      createConversation(this.prepareCaptchaConversation.bind(this), 'captchaConversation')
    );
    this.handleAnyPrivateMessage();
  }

  private handleAnyPrivateMessage(): void {
    // только приватные каналы
    const pm = this.bot.chatType('private');

    // пересылка всех сообщений от пользователей в бот
    this.handleUserPrivateMessage(pm);

    // отправка ответов пользователям
    this.handleAdminResponse(pm);
  }

  private handleAdminResponse(pm: Composer<ChatTypeContext<BotContext, 'private'>>): void {
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

        await this.bot.api.copyMessage(
          messageMetadata.userChatId,
          ctx.chat.id,
          ctx.message.message_id,
          {
            reply_to_message_id: messageMetadata.userMessageId,
          }
        );
      }
    );
  }

  private handleUserPrivateMessage(pm: Composer<ChatTypeContext<BotContext, 'private'>>): void {
    pm.filter((ctx) => ctx.from.id !== this.config.ownerId).on('message', async (ctx) => {
      if (ctx.config.captchaMode) {
        return this.sendCaptcha(ctx);
      }

      await this.forwardUserMessageToBot(ctx);
    });
  }

  private async forwardUserMessageToBot(ctx: BotContext): Promise<void> {
    const forwardMessage = await ctx.forwardMessage(this.config.ownerId);

    await this.messagesRepository.insert({
      userChatId: ctx.from.id,
      userMessageId: ctx.message.message_id,
      botMessageId: forwardMessage.message_id,
    });
  }

  private async handleSpecificCommand(
    ctx: BotContext,
    messageMetadata: MessageEntity
  ): Promise<boolean> {
    const preparedText = (ctx?.message?.text || '').toLowerCase().trim();

    switch (preparedText) {
      case 'бан':
        return this.banUser(ctx, messageMetadata);
      case 'капча':
        return this.enableCaptcha(ctx, messageMetadata);
      default:
        return false;
    }
  }

  private async banUser(ctx: BotContext, messageMetadata: MessageEntity): Promise<boolean> {
    await this.bot.api.sendMessage(
      messageMetadata.userChatId,
      'Тебе ограничен доступ к боту, больше он не будет реагировать на сообщения'
    );
    ctx.reply('Пользователь заблокирован', {reply_to_message_id: ctx.message.message_id});
    await this.userRepository.update({id: messageMetadata.userChatId}, {banned: true});
    return true;
  }

  private async enableCaptcha(ctx: BotContext, messageMetadata: MessageEntity): Promise<boolean> {
    await this.userRepository.update({id: messageMetadata.userChatId}, {captcha: true});
    ctx.reply('Пользователю включена капча', {reply_to_message_id: ctx.message.message_id});
    return true;
  }

  private async sendCaptcha(ctx: BotContext): Promise<void> {
    ctx.session.captchaValues = this.prepareCaptchaValues();
    await ctx.conversation.enter('captchaConversation');
  }

  private async prepareCaptchaConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    const {first, second, operand, result} = conversation.session.captchaValues;
    let message = `Для того чтобы сообщение было доставлено, нужно решить задачу.\n`;
    message += `Пока ты не решишь, бот не будет отвечать\n\n`;
    message += `Чему равно <b>${first} ${operand} ${second}?</b>\n\n`;
    message += `Ответ пришли одним числом`;
    const captchaMessage = await ctx.reply(message, {parse_mode: 'HTML'});

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answerCtx = await conversation.wait();

      if (Number(answerCtx?.message?.text.trim()) === result) {
        await answerCtx.deleteMessage();
        await answerCtx.api.deleteMessage(captchaMessage.chat.id, captchaMessage.message_id);
        conversation.session.captchaValues = null;
        await this.forwardUserMessageToBot(ctx);
        return;
      }
      await answerCtx.deleteMessage();
    }
  }

  private prepareCaptchaValues(): {
    first: number;
    second: number;
    operand: string;
    result: number;
  } {
    const values = [
      CommonService.randomIntFromInterval(1, 25),
      CommonService.randomIntFromInterval(1, 25),
    ].sort((a, b) => b - a);
    const [first, second] = values;

    const operandCase = CommonService.randomIntFromInterval(0, 1);
    let operand: string;
    let result;
    switch (operandCase) {
      case 0:
        result = first + second;
        operand = '+';
        break;
      case 1:
        result = first - second;
        operand = '-';
        break;
    }
    return {first, second, operand, result};
  }
}
