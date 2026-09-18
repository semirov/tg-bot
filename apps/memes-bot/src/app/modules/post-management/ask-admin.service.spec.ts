import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { AskAdminService } from './ask-admin.service';
import { ConversationsEnum } from './constants/conversations.enum';

describe('AskAdminService', () => {
  function createHarness() {
    const userRepo = { update: jest.fn().mockResolvedValue(undefined) };
    const userService = { repository: userRepo };
    const baseConfigService = { userRequestMemeChannel: -1001 };
    const bot = {
      errorBoundary: jest.fn(),
      callbackQuery: jest.fn(),
    };
    const service = new AskAdminService(
      bot as any,
      baseConfigService as any,
      userService as any
    );
    return { service, bot, userService, userRepo };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    it('вешает два errorBoundary (логгер и диалог) и два callbackQuery', () => {
      const h = createHarness();

      h.service.onModuleInit();

      expect(h.bot.errorBoundary).toHaveBeenCalledTimes(2);
      expect(h.bot.callbackQuery).toHaveBeenCalledTimes(2);
      // вторым аргументом во второй boundary идёт обёрнутый диалог
      expect(h.bot.errorBoundary.mock.calls[1][1]).toBeInstanceOf(Function);
    });

    it('оба errorBoundary логируют ошибку через Logger.log', () => {
      const h = createHarness();
      h.service.onModuleInit();

      h.bot.errorBoundary.mock.calls[0][0](new Error('first'));
      h.bot.errorBoundary.mock.calls[1][0](new Error('second'));

      expect(Logger.log).toHaveBeenNthCalledWith(1, new Error('first'));
      expect(Logger.log).toHaveBeenNthCalledWith(2, new Error('second'));
    });
  });

  describe('adminUserConversation', () => {
    it('пересылает ответ админа пользователю и чистит сессию', async () => {
      const h = createHarness();
      const conversation = {
        wait: jest.fn().mockResolvedValue({
          message: { chat: { id: 500 }, message_id: 600 },
        }),
      };
      const ctx: any = {
        reply: jest.fn().mockResolvedValue(undefined),
        deleteMessage: jest.fn().mockResolvedValue(undefined),
        api: { copyMessage: jest.fn().mockResolvedValue({ message_id: 601 }) },
        session: {
          adminUserConversationUserId: 42,
          adminUserConversationMessageId: 100,
        },
      };

      await h.service.adminUserConversation(conversation as any, ctx);

      expect(ctx.reply).toHaveBeenNthCalledWith(1, 'Напиши ответ пользователю');
      expect(ctx.api.copyMessage).toHaveBeenCalledWith(42, 500, 600, {
        reply_to_message_id: 100,
        disable_notification: true,
      });
      expect(ctx.reply).toHaveBeenLastCalledWith('Сообщение отправлено пользователю');
      // сессия обнуляется, чтобы следующий ответ не улетел не туда
      expect(ctx.session.adminUserConversationUserId).toBeUndefined();
      expect(ctx.session.adminUserConversationMessageId).toBeUndefined();
      expect(ctx.deleteMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('onAdminUserQuery', () => {
    it('старт диалога сохраняет id пользователя/сообщения и входит в диалог', async () => {
      const h = createHarness();
      h.service.onModuleInit();

      const handler = h.bot.callbackQuery.mock.calls[0][1];
      const ctx: any = {
        callbackQuery: { data: 'admin_user_dialog_start$42$100' },
        session: {},
        conversation: { enter: jest.fn().mockResolvedValue(undefined) },
      };

      await handler(ctx);

      expect(ctx.session.adminUserConversationUserId).toBe(42);
      expect(ctx.session.adminUserConversationMessageId).toBe(100);
      expect(ctx.conversation.enter).toHaveBeenCalledWith(
        ConversationsEnum.ADMIN_USER_CONVERSATION
      );
    });

    it('бан из диалога обновляет пользователя и уведомляет его', async () => {
      const h = createHarness();
      h.service.onModuleInit();

      const handler = h.bot.callbackQuery.mock.calls[1][1];
      const ctx: any = {
        callbackQuery: {
          data: 'admin_user_dialog_ban_user$7$55',
          from: { id: 9 },
        },
        api: { sendMessage: jest.fn().mockResolvedValue(undefined) },
      };

      await handler(ctx);

      expect(h.userRepo.update).toHaveBeenCalledWith(
        { id: 7 },
        { isBanned: true, bannedBy: 9 }
      );
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        7,
        expect.stringContaining('ограничить доступ'),
        { reply_to_message_id: 55 }
      );
    });
  });
});
