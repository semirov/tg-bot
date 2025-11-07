import { Conversation, createConversation } from '@grammyjs/conversations';
import { BotContext } from '../bot/interfaces/bot-context.interface';
import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { BOT } from '../bot/providers/bot.provider';
import { Bot, Composer, InlineKeyboard } from 'grammy';
import { Menu } from '@grammyjs/menu';
import { BaseConfigService } from '../config/base-config.service';
import { UserService } from '../bot/services/user.service';
import { UserPermissionEnum } from '../bot/constants/user-permission.enum';
import { PublicationModesEnum } from './constants/publication-modes.enum';
import { PostModerationMenusEnum } from './constants/post-moderation-menus.enum';
import { add, format, formatDistance } from 'date-fns';
import { UserRequestService } from '../bot/services/user-request.service';
import {
  PostSchedulerService,
  ScheduledPostContextInterface,
} from '../bot/services/post-scheduler.service';
import { SettingsService } from '../bot/services/settings.service';
import { CringeManagementService } from '../bot/services/cringe-management.service';
import { DeduplicationService } from '../bot/services/deduplication.service';
import * as console from 'node:console';
import { ru } from 'date-fns/locale';
import { Injectable } from '@nestjs/common';

@Injectable()
export class UserPostManagementService implements OnModuleInit {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userService: UserService,
    private userRequestService: UserRequestService,
    private postSchedulerService: PostSchedulerService,
    private settingsService: SettingsService,
    private cringeManagementService: CringeManagementService,
    private deduplicationService: DeduplicationService
  ) {}

  private moderatedPostMenu: Menu<BotContext>;
  private replyToBotContext: Composer<BotContext>;
  private duplicateMenu: Menu<BotContext>;

  private limitMenu: Menu<BotContext>;

  public onModuleInit(): void {
    this.buildModeratedPostMenu();
    this.buildDuplicateMenu(); // Добавляем создание меню для дубликатов
    this.limitMenu = this.buildLimitMenu();
    this.bot.use(this.limitMenu);
    this.prepareReplyToBotContext();
    this.handleAdminUserResponse();

    // Обработчик кнопки снятия лимита с улучшенной проверкой и логированием
    this.bot.callbackQuery(/^admin_lift_limit_(\d+)$/, async (ctx) => {
      try {
        const userId = parseInt(ctx.match[1]);
        const moderatorId = ctx.callbackQuery.from.id;

        if (!this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          await ctx.answerCallbackQuery('Недостаточно прав для снятия лимита');
          return;
        }

        await this.userService.disableMemeLimitForUser(userId, 24);

        Logger.log(
          `Moderator ${moderatorId} lifted limit for user ${userId}`,
          UserPostManagementService.name
        );

        await ctx.answerCallbackQuery('Лимит снят на 24 часа');
        await ctx.editMessageText(
          `${ctx.callbackQuery.message.text}\n\n✅ Лимит снят модератором @${ctx.callbackQuery.from.username}`,
          { reply_markup: null }
        );
      } catch (error) {
        Logger.error(`Failed to lift limit: ${error.message}`, UserPostManagementService.name);
        await ctx.answerCallbackQuery('Ошибка при снятии лимита');
      }
    });
  }

  public async handleUserTextRequest(ctx: BotContext): Promise<void> {
    try {
      await ctx.react('👍');
    } catch (e) {
      await ctx.reply('Мы получили твоё обращение и скоро ответим');
      Logger.warn(
        `Cannot set message reaction for user text message in bot ${ctx.me.id}`,
        UserPostManagementService.name
      );
    }

    const user = await this.userService.repository.findOne({
      where: { id: ctx.message.from.id },
    });

    const { first_name, last_name, username, is_bot, is_premium } = ctx.message.from;

    // Формируем текст для обращения
    const userText = [
      '📝 Обращение от',
      is_premium ? '👑' : null,
      is_bot ? '🤖' : null,
      first_name,
      last_name,
      username ? `@${username}` : null,
    ]
      .filter((v) => !!v)
      .join(' ');

    // Отправляем информацию о пользователе в канал запросов
    await this.bot.api.sendMessage(this.baseConfigService.userRequestMemeChannel, userText, {
      disable_notification: true,
    });

    // Если это ответ на сообщение, сначала пересылаем сообщение, на которое ответил пользователь
    if (ctx.message.reply_to_message) {
      try {
        // Отправляем сообщение, на которое ответил пользователь
        const replyMessage = await ctx.api.forwardMessage(
          this.baseConfigService.userRequestMemeChannel,
          ctx.message.chat.id,
          ctx.message.reply_to_message.message_id
        );

        // Добавляем уточнение, что пользователь ответил на это сообщение
        await this.bot.api.sendMessage(
          this.baseConfigService.userRequestMemeChannel,
          '👆 Пользователь ответил на это сообщение:',
          { disable_notification: true }
        );
      } catch (e) {
        Logger.warn(
          `Cannot forward reply_to_message: ${e.message}`,
          UserPostManagementService.name
        );

        // Если не удалось переслать, то хотя бы поясняем в тексте
        await this.bot.api.sendMessage(
          this.baseConfigService.userRequestMemeChannel,
          'Пользователь ответил на сообщение, но его не удалось переслать. Возможно, это слишком старое сообщение.',
          { disable_notification: true }
        );
      }
    }

    // Копируем сообщение пользователя без меню модерации
    const message = await ctx.api.copyMessage(
      this.baseConfigService.userRequestMemeChannel,
      ctx.message.chat.id,
      ctx.message.message_id,
      { disable_notification: true }
    );

    // Закрепляем сообщение
    await this.bot.api.pinChatMessage(
      this.baseConfigService.userRequestMemeChannel,
      message.message_id,
      { disable_notification: true }
    );

    // Сохраняем информацию о запросе в БД
    await this.userRequestService.repository.insert({
      user: user,
      isAnonymousPublishing: false,
      originalMessageId: ctx.message.message_id,
      userRequestChannelMessageId: message.message_id,
      isTextRequest: true,
      replyToMessageId: ctx.message.reply_to_message?.message_id, // Сохраняем ID сообщения, на которое был ответ
    });

    await this.userService.updateUserLastActivity(ctx);
  }

  private buildLimitMenu(): Menu<BotContext> {
    return new Menu<BotContext>('limit-menu', { autoAnswer: false }).text(
      '🔓 Снять лимит',
      async (ctx) => {
        try {
          const message = await this.userRequestService.repository.findOne({
            where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
            relations: { user: true },
          });

          if (!message) {
            Logger.error(
              `Message not found for message_id: ${ctx.callbackQuery.message.message_id}`,
              UserPostManagementService.name
            );
            await ctx.answerCallbackQuery('Ошибка: сообщение не найдено');
            return;
          }

          if (!this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
            await ctx.answerCallbackQuery('Недостаточно прав');
            return;
          }

          if (!message.user) {
            Logger.error(
              `User not found for message: ${message.id}`,
              UserPostManagementService.name
            );
            await ctx.answerCallbackQuery('Ошибка: пользователь не найден');
            return;
          }

          await this.userService.disableMemeLimitForUser(message.user.id, 24);

          // Проверяем на дубликаты после снятия лимита
          let hasDuplicate = false;
          if (ctx.callbackQuery.message?.photo) {
            const hash = await this.deduplicationService.getPostImageHash(
              ctx.callbackQuery.message.photo
            );
            if (hash) {
              const duplicates = await this.deduplicationService.checkDuplicate(hash);
              if (duplicates.some((d) => d.distance >= 0.5)) {
                hasDuplicate = true;
              } else {
                const scheduledDup = await this.checkScheduledDuplicates(hash);
                if (scheduledDup) {
                  hasDuplicate = true;
                }
              }
            }
          }

          // Обновляем запись в БД
          await this.userRequestService.repository.update(
            { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
            { possibleDuplicate: hasDuplicate }
          );

          // Показываем соответствующее меню
          const menuToUse = hasDuplicate ? this.duplicateMenu : this.moderatedPostMenu;
          await ctx.editMessageReplyMarkup({ reply_markup: menuToUse });

          await this.bot.api.sendMessage(
            message.user.id,
            '✅ Админ снял для тебя ограничение на публикацию постов на текущие сутки',
            { reply_to_message_id: message.originalMessageId }
          );

          await ctx.answerCallbackQuery('Лимит снят на 24 часа');
        } catch (error) {
          Logger.error(
            `Error in limit menu handler: ${error.message}`,
            UserPostManagementService.name
          );
          await ctx.answerCallbackQuery('Произошла ошибка');
        }
      }
    );
  }

  public async handleUserMemeRequest(ctx: BotContext): Promise<void> {
    try {
      await ctx.react('👍');

      // Проверка лимита мемов (сообщений с медиа: изображения/видео) для всех пользователей
      const user = await this.userService.repository.findOne({
        where: { id: ctx.message.from.id },
      });

      // Добавляем подробное логирование для отладки
      Logger.log(
        `Checking meme limit for user ${user.id} (${user.username || 'no username'})`,
        UserPostManagementService.name
      );

      const now = new Date();
      const isLimitDisabled = user.memeLimitDisabledUntil && now < user.memeLimitDisabledUntil;

      Logger.log(
        `User limit status - disabled: ${isLimitDisabled}, limit disabled until: ${user.memeLimitDisabledUntil}`,
        UserPostManagementService.name
      );

      const isAdmin = this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR);
      // Подсчитываем только сообщения с медиа (изображения/видео) за последние 24 часа
      const todayMemeCount = await this.userRequestService.countUserMemeRequestsLast24h(user.id);

      Logger.log(
        `User ${user.id} has sent ${todayMemeCount} media messages (memes) in the last 24 hours`,
        UserPostManagementService.name
      );

      if (!isLimitDisabled && todayMemeCount >= 5) {
        const remainingTime = formatDistance(add(now, { days: 1 }), now, {
          locale: ru,
          addSuffix: true,
        });

        const message =
          `🚫 Лимит превышен!\n\n` +
          `Ты уже прислал ${todayMemeCount}/5 постов за последние 24 часа.\n` +
          `Новый лимит будет доступен ${remainingTime}.\n\n`;

        await ctx.reply(message, {
          reply_to_message_id: ctx.message.message_id,
          parse_mode: 'HTML',
        });

        if (!isAdmin) {
          return;
        }

        // Сохраняем запрос в БД без проверки на дубликаты
        const savedRequest = await this.userRequestService.repository.insert({
          user: user,
          isAnonymousPublishing: false,
          originalMessageId: ctx.message.message_id,
          userRequestChannelMessageId: null,
          possibleDuplicate: false,
        });

        // Копируем сообщение в канал запросов
        const channelMessage = await ctx.api.copyMessage(
          this.baseConfigService.userRequestMemeChannel,
          ctx.message.chat.id,
          ctx.message.message_id,
          { disable_notification: true }
        );

        // Обновляем запись с ID сообщения в канале
        await this.userRequestService.repository.update(savedRequest.identifiers[0].id, {
          userRequestChannelMessageId: channelMessage.message_id,
        });

        // Показываем меню с кнопкой снятия лимита
        await ctx.api.editMessageReplyMarkup(
          this.baseConfigService.userRequestMemeChannel,
          channelMessage.message_id,
          { reply_markup: this.buildLimitMenu() }
        );
        return;
      }

      // Логируем случаи переопределения лимита
      if (isLimitDisabled) {
        Logger.log(
          `User ${user.id} posted with disabled limit (until ${user.memeLimitDisabledUntil})`,
          UserPostManagementService.name
        );
      }
    } catch (e) {
      await ctx.reply('Мы все получили и скоро ответим');
      Logger.warn(
        `Cannot set message reaction for user message in bot ${ctx.me.id}`,
        UserPostManagementService.name
      );
    }

    const user = await this.userService.repository.findOne({
      where: { id: ctx.message.from.id },
    });

    const { first_name, last_name, username, is_bot, is_premium } = ctx.message.from;

    let userText = [
      'Пост от',
      is_premium ? '👑' : null,
      is_bot ? '🤖' : null,
      first_name,
      last_name,
      username ? `@${username}` : null,
      '\n#предложка',
    ]
      .filter((v) => !!v)
      .join(' ');

    // Проверяем на дубликаты только если есть фото (для видео это не работает)
    let menuToUse: Menu<BotContext> = this.moderatedPostMenu;
    let hasPossibleDuplicate = false;
    let bestMatch = null;
    let scheduledDuplicate = null;

    if (ctx.message?.photo) {
      const hash = await this.deduplicationService.getPostImageHash(ctx.message.photo);
      if (hash) {
        // Проверяем опубликованные посты
        const duplicates = await this.deduplicationService.checkDuplicate(hash);

        if (duplicates.some((duplicate) => duplicate.distance >= 0.5)) {
          // Находим лучшее совпадение
          bestMatch = duplicates.reduce((prev, current) =>
            prev.distance > current.distance ? prev : current
          );

          // Форматируем процент совпадения
          const matchPercentage = Math.round(bestMatch.distance * 100);

          // Добавляем информацию о дубликате в текст сообщения
          userText += `\n🔄 Возможный дубликат (совпадение ${matchPercentage}%)`;
          hasPossibleDuplicate = true;

          // Используем специальное меню для дубликатов
          menuToUse = this.duplicateMenu;
        } else {
          // Если нет совпадений среди опубликованных, проверяем в запланированных
          scheduledDuplicate = await this.checkScheduledDuplicates(hash);

          if (scheduledDuplicate && this.isValidDate(scheduledDuplicate.scheduledDate)) {
            const matchPercentage = Math.round(scheduledDuplicate.distance * 100);

            try {
              const formattedDate = format(scheduledDuplicate.scheduledDate, 'dd.LL.yy в ~HH:mm', {
                locale: ru,
              });

              // Добавляем информацию о запланированном дубликате
              userText += `\n🕒 Похожий пост (${matchPercentage}%) запланирован на ${formattedDate}`;
            } catch (error) {
              // В случае ошибки форматирования, используем более простой вариант
              userText += `\n🕒 Похожий пост (${matchPercentage}%) запланирован к публикации`;
            }

            hasPossibleDuplicate = true;
            menuToUse = this.duplicateMenu;
          }
        }
      }
    }

    await this.bot.api.sendMessage(this.baseConfigService.userRequestMemeChannel, userText, {
      disable_notification: true,
    });

    // Если есть потенциальный дубликат среди опубликованных, отправляем его для сравнения
    if (hasPossibleDuplicate && bestMatch) {
      try {
        await this.bot.api.forwardMessage(
          this.baseConfigService.userRequestMemeChannel,
          this.baseConfigService.memeChanelId,
          bestMatch.memePostId,
          { disable_notification: true }
        );
      } catch (error) {
        Logger.error(
          `Failed to forward duplicate post ${bestMatch.memePostId}: ${error.message}`,
          UserPostManagementService.name
        );
      }
    }

    // Если есть потенциальный дубликат среди запланированных
    if (hasPossibleDuplicate && scheduledDuplicate && !bestMatch) {
      try {
        // Проверяем валидность даты перед форматированием
        if (this.isValidDate(scheduledDuplicate.scheduledDate)) {
          const formattedDate = format(scheduledDuplicate.scheduledDate, 'dd.LL.yy в ~HH:mm', {
            locale: ru,
          });

          const timeDistance = formatDistance(scheduledDuplicate.scheduledDate, new Date(), {
            locale: ru,
            addSuffix: false,
          });

          // Отправляем сообщение о запланированном посте с деталями
          await this.bot.api.sendMessage(
            this.baseConfigService.userRequestMemeChannel,
            `👆 Похожий пост запланирован на ${formattedDate} (через ${timeDistance})\n\nID поста: ${scheduledDuplicate.postId}`,
            { disable_notification: true }
          );
        } else {
          // Если дата невалидна, отправляем сообщение без форматирования
          await this.bot.api.sendMessage(
            this.baseConfigService.userRequestMemeChannel,
            `👆 Похожий пост запланирован к публикации.\n\nID поста: ${scheduledDuplicate.postId}`,
            { disable_notification: true }
          );
        }

        // Пытаемся получить и переслать запланированный пост
        try {
          const scheduledPost = await this.postSchedulerService.getScheduledPostById(
            scheduledDuplicate.postId
          );
          if (scheduledPost && scheduledPost.requestChannelMessageId) {
            await this.bot.api.forwardMessage(
              this.baseConfigService.userRequestMemeChannel,
              this.baseConfigService.userRequestMemeChannel,
              scheduledPost.requestChannelMessageId,
              { disable_notification: true }
            );
          }
        } catch (err) {
          Logger.warn(
            `Failed to forward scheduled post preview: ${err.message}`,
            UserPostManagementService.name
          );
        }
      } catch (error) {
        Logger.error(
          `Failed to send scheduled duplicate info: ${error.message}`,
          UserPostManagementService.name
        );
      }
    }

    const message = await ctx.api.copyMessage(
      this.baseConfigService.userRequestMemeChannel,
      ctx.message.chat.id,
      ctx.message.message_id,
      { reply_markup: menuToUse, disable_notification: true }
    );

    await this.bot.api.pinChatMessage(
      this.baseConfigService.userRequestMemeChannel,
      message.message_id,
      { disable_notification: true }
    );

    await this.userRequestService.repository.insert({
      user: user,
      isAnonymousPublishing: false,
      originalMessageId: ctx.message.message_id,
      userRequestChannelMessageId: message.message_id,
      possibleDuplicate: hasPossibleDuplicate,
      scheduledDuplicateId: scheduledDuplicate?.postId, // Сохраняем ID запланированного дубликата
    });

    await this.userService.updateUserLastActivity(ctx);
  }

  /**
   * Проверяет наличие похожих постов среди запланированных
   */
  private async checkScheduledDuplicates(hash: string): Promise<{
    postId: number;
    distance: number;
    scheduledDate: Date;
  } | null> {
    if (!hash) return null;

    try {
      // Получаем все запланированные посты
      const scheduledPosts = await this.postSchedulerService.getAllScheduledPosts();

      if (!scheduledPosts || scheduledPosts.length === 0) return null;

      // Проходим по запланированным постам и ищем похожие
      const potentialDuplicates = [];

      for (const post of scheduledPosts) {
        // Если у поста есть хеш изображения и валидная дата
        if (post.hash && post.publishDate && this.isValidDate(post.publishDate)) {
          // Вычисляем "расстояние" между хешами (чем ближе к 1, тем более похожи)
          const distance = this.deduplicationService.calculateHashDistance(hash, post.hash);

          // Если расстояние достаточно большое (схожесть высокая)
          if (distance >= 0.5) {
            potentialDuplicates.push({
              postId: post.id,
              distance: distance,
              scheduledDate: post.publishDate,
            });
          }
        }
      }

      // Если нашли потенциальные дубликаты, возвращаем самый похожий
      if (potentialDuplicates.length > 0) {
        return potentialDuplicates.reduce((prev, current) =>
          prev.distance > current.distance ? prev : current
        );
      }

      return null;
    } catch (error) {
      Logger.error(
        `Failed to check scheduled duplicates: ${error.message}`,
        UserPostManagementService.name
      );
      return null;
    }
  }

  // Вспомогательная функция для проверки валидности даты
  private isValidDate(date: any): boolean {
    if (!date) return false;

    // Преобразуем в объект Date, если это строка или число
    const dateObj = date instanceof Date ? date : new Date(date);

    // Проверяем, что это валидная дата (не NaN)
    return !isNaN(dateObj.getTime());
  }

  // Обновляем метод buildDuplicateMenu, чтобы он также мог обрабатывать запланированные дубликаты
  private buildDuplicateMenu() {
    return new Menu<BotContext>('duplicate-check-menu', { autoAnswer: false })
      .text('✅ Дубликат', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          // Обработка подтвержденного дубликата
          const message = await this.userRequestService.repository.findOne({
            relations: { user: true },
            where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
          });

          // Проверяем, является ли это дубликатом запланированного поста
          if (message.scheduledDuplicateId) {
            // Получаем информацию о запланированном посте
            const scheduledPost = await this.postSchedulerService.getScheduledPostById(
              message.scheduledDuplicateId
            );

            if (scheduledPost && this.isValidDate(scheduledPost.publishDate)) {
              const scheduledDateFormatted = format(
                scheduledPost.publishDate,
                'dd.LL.yy в ~HH:mm',
                { locale: ru }
              );

              // Уведомляем пользователя о запланированном посте
              await this.bot.api.sendMessage(
                message.user.id,
                `Похожий пост уже запланирован к публикации ${scheduledDateFormatted}.\nТы можешь предложить что-нибудь другое`,
                { reply_to_message_id: message.originalMessageId }
              );
            } else {
              // Стандартное сообщение, если не удалось получить детали о запланированном посте
              await this.bot.api.sendMessage(
                message.user.id,
                'Похожий пост уже запланирован к публикации. Ты можешь предложить что-нибудь другое'
              );
            }
          } else {
            // Стандартное сообщение для дубликата опубликованного поста
            await this.bot.api.sendMessage(
              message.user.id,
              'Этот пост уже публиковался, ты можешь предложить что-нибудь другое'
            );

            // Находим дубликат снова и пересылаем его
            const hash = await this.deduplicationService.getPostImageHash(
              ctx.callbackQuery.message.photo
            );
            if (hash) {
              const duplicates = await this.deduplicationService.checkDuplicate(hash);
              if (duplicates.length > 0) {
                const bestMatch = duplicates.reduce((prev, current) =>
                  prev.distance > current.distance ? prev : current
                );

                // Отправляем оригинальный пост
                try {
                  await this.bot.api.forwardMessage(
                    message.user.id,
                    this.baseConfigService.memeChanelId,
                    bestMatch.memePostId
                  );
                } catch (error) {
                  Logger.error(
                    `Failed to forward original post to user: ${error.message}`,
                    UserPostManagementService.name
                  );
                }
              }
            }
          }

          // Обновляем статус запроса
          await this.userRequestService.repository.update(
            { id: message.id },
            {
              isApproved: false,
              isDuplicate: true,
              processedByModerator: { id: ctx.callbackQuery.from.id },
              moderatedAt: new Date(),
            }
          );

          // Удаляем сообщение из чата модераторов
          await ctx.unpinChatMessage();
          await ctx.deleteMessage();
        }
      })
      .text('❌ Не дубликат', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          // Получаем информацию о сообщении
          const message = await this.userRequestService.repository.findOne({
            relations: { user: true },
            where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
          });

          // Обновляем статус запроса, отмечая что ручная проверка на дубликат пройдена
          await this.userRequestService.repository.update(
            { id: message.id },
            {
              possibleDuplicate: false, // Подтверждаем, что это НЕ дубликат
              scheduledDuplicateId: null, // Очищаем ссылку на запланированный дубликат
              checkedByModerator: ctx.callbackQuery.from.id,
            }
          );

          // Заменяем меню на стандартное меню модерации
          try {
            await ctx.editMessageReplyMarkup({
              reply_markup: this.moderatedPostMenu,
            });
          } catch (error) {
            Logger.error(
              `Failed to update message menu: ${error.message}`,
              UserPostManagementService.name
            );

            // Альтернативный вариант: полностью заменить сообщение
            try {
              const originalMessage = ctx.callbackQuery.message;
              await ctx.api.deleteMessage(originalMessage.chat.id, originalMessage.message_id);
              await ctx.api.copyMessage(
                originalMessage.chat.id,
                originalMessage.chat.id,
                originalMessage.message_id,
                {
                  reply_markup: this.moderatedPostMenu,
                }
              );
            } catch (secondError) {
              Logger.error(
                `Failed to recreate message with new menu: ${secondError.message}`,
                UserPostManagementService.name
              );
            }
          }
        }
      })
      .row();
  }
  private buildModeratedPostMenu() {
    const menu = new Menu<BotContext>(PostModerationMenusEnum.MODERATION, { autoAnswer: false })
      .text('👍 Одобрить', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          await this.onModeratorApprovalActions(ctx);
          ctx.menu.nav(PostModerationMenusEnum.APPROVAL);
        }
      })
      .text('👎 Отклонить', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          await this.onModeratorRejectActions(ctx);
          ctx.menu.nav(PostModerationMenusEnum.REJECT);
        }
      });

    // Основное меню модерации содержит только кнопки одобрить/отклонить

    const approvedSubmenu = new Menu<BotContext>(PostModerationMenusEnum.APPROVAL, {
      autoAnswer: false,
    })
      .text(
        async (ctx) => {
          const message = await this.userRequestService.repository.findOne({
            select: ['processedByModerator'],
            where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
            relations: { processedByModerator: true },
          });
          return `✅ Опубликовать (${message.processedByModerator.username})`;
        },
        async (ctx) => {
          if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL)) {
            ctx.menu.nav(PostModerationMenusEnum.PUBLICATION);
          }
        }
      )
      .row()
      .text(async (ctx) => {
        const statistic = await this.userRequestService.userPostDiscardStatistic(ctx);
        return `👎 ${statistic.total} (${statistic.week})`;
      })
      .text(async (ctx) => {
        const statistic = await this.userRequestService.userPostApprovedStatistic(ctx);
        return `👍 ${statistic.total} (${statistic.day})`;
      })
      .text(async (ctx) => {
        const lastPostInfo = await this.userRequestService.lastPublishedPostTimeAgo(ctx);
        return `🗓 ${lastPostInfo}`;
      })
      .row();

    const publishSubmenu = new Menu<BotContext>(PostModerationMenusEnum.PUBLICATION, {
      autoAnswer: false,
    })
      .text('Кринж', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NIGHT_CRINGE))
      .text('Сейчас', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NOW_SILENT))
      .row()
      .text('Ближайший слот', async (ctx) =>
        this.onPublishActions(ctx, PublicationModesEnum.NEXT_INTERVAL)
      )
      .row()
      .text('Ночью', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_NIGHT))
      .text('Утром', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_MORNING))
      .text('Днем', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_MIDDAY))
      .text('Вечером', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_EVENING))
      .row()
      .text('Назад', (ctx) => ctx.menu.nav(PostModerationMenusEnum.APPROVAL));

    const rejectSubmenu = new Menu<BotContext>(PostModerationMenusEnum.REJECT, {
      autoAnswer: false,
    })
      .text(
        async (ctx) => {
          const message = await this.userRequestService.repository.findOne({
            select: ['processedByModerator'],
            where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
            relations: { processedByModerator: true },
          });
          await ctx.unpinChatMessage(ctx.callbackQuery.message.message_id);
          return `👨 Отклонен ❌ (${message.processedByModerator.username})`;
        },
        async (ctx) => {
          if (
            this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_DELETE_REJECTED_POST)
          ) {
            await ctx.deleteMessage();
          }
        }
      )
      .row()
      .text('🔁', async (ctx) => {
        if (
          this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_RESTORE_DISCARDED_POST)
        ) {
          await this.onAdminApproveAfterReject(ctx);
          ctx.menu.nav(PostModerationMenusEnum.APPROVAL);
        }
      })
      .text(
        async (ctx) => {
          const stikesCount = await this.getUserStrikesCount(ctx);
          return `❗ ${stikesCount || 0}`;
        },
        async (ctx) => {
          if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_SET_STRIKE)) {
            ctx.menu.nav(PostModerationMenusEnum.STRIKE);
          }
        }
      )
      .text('💀', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_MAKE_BAN)) {
          await this.onAdminApproveAfterReject(ctx);
          ctx.menu.nav(PostModerationMenusEnum.BAN);
        }
      })
      .row();

    const banConfirmation = new Menu<BotContext>(PostModerationMenusEnum.BAN, { autoAnswer: false })
      .text('Точно в бан?', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_MAKE_BAN)) {
          await this.banUser(ctx);
          await ctx.deleteMessage();
        }
        return;
      })
      .text('Нет', async (ctx) => {
        ctx.menu.nav(PostModerationMenusEnum.REJECT);
      })
      .row();

    const strikeConfirmation = new Menu<BotContext>(PostModerationMenusEnum.STRIKE, {
      autoAnswer: false,
    })
      .text('Точно добавить страйк?', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_SET_STRIKE)) {
          await this.makeUserStrike(ctx);
          ctx.menu.nav(PostModerationMenusEnum.REJECT);
        }
      })
      .text('Нет', async (ctx) => {
        ctx.menu.nav(PostModerationMenusEnum.REJECT);
      })
      .row();

    // Регистрируем все подменю
    menu.register(publishSubmenu);
    menu.register(banConfirmation);
    menu.register(strikeConfirmation);
    menu.register(approvedSubmenu);
    menu.register(rejectSubmenu);

    this.moderatedPostMenu = menu;
    this.bot.use(this.moderatedPostMenu);

    // Создаем и регистрируем меню для дубликатов отдельно
    this.duplicateMenu = this.buildDuplicateMenu();
    this.bot.use(this.duplicateMenu);
  }

  /**
   * Обработка нажатия кнопки одобрить
   */
  private async onModeratorApprovalActions(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      where: {
        userRequestChannelMessageId: ctx.update.callback_query.message.message_id,
      },
    });
    await this.userRequestService.repository.update(
      { id: message.id },
      {
        isApproved: true,
        processedByModerator: { id: ctx.callbackQuery.from.id },
        moderatedAt: new Date(),
      }
    );
    return;
  }

  /**
   * Обработка нажатия кнопки отклонить в для модерируемого поста
   */
  private async onModeratorRejectActions(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      relations: { user: true },
      where: {
        userRequestChannelMessageId: ctx.update.callback_query.message.message_id,
      },
    });

    await this.userRequestService.repository.update(
      { id: message.id },
      {
        isApproved: false,
        processedByModerator: { id: ctx.callbackQuery.from.id },
        moderatedAt: new Date(),
      }
    );
    await this.bot.api
      .forwardMessage(message.user.id, message.user.id, message.originalMessageId)
      .catch();
    await this.bot.api.sendMessage(
      message.user.id,
      'Мы не можем такое опубликовать, твой пост отклонен'
    );
  }

  /**
   * Обработка нажатия кнопки опубликовать для одобренного модераторами поста
   */
  public async onPublishActions(ctx: BotContext, mode: PublicationModesEnum) {
    if (!this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL)) {
      return;
    }

    await ctx.unpinChatMessage(ctx.callbackQuery.message.message_id);
    const imageHash = await this.deduplicationService.getPostImageHash(
      ctx?.callbackQuery?.message?.photo
    );

    const publishContext: ScheduledPostContextInterface = {
      mode,
      requestChannelMessageId: ctx.callbackQuery.message.message_id,
      processedByModerator: ctx.callbackQuery.from.id,
      caption: ctx.callbackQuery?.message?.caption,
      isUserPost: true,
      hash: imageHash,
    };

    switch (mode) {
      case PublicationModesEnum.NOW_SILENT:
        return this.onPublishNow(publishContext);
      case PublicationModesEnum.NEXT_MORNING:
      case PublicationModesEnum.NEXT_MIDDAY:
      case PublicationModesEnum.NEXT_EVENING:
      case PublicationModesEnum.NEXT_INTERVAL:
      case PublicationModesEnum.NEXT_NIGHT:
        return this.publishScheduled(publishContext);
      case PublicationModesEnum.NIGHT_CRINGE:
        return this.publishNightCringeScheduled(publishContext);
    }
  }

  private handleAdminUserResponse(): void {
    this.replyToBotContext.on(['message', 'channel_post'], async (ctx) => {
      const adminMessageId = ctx?.channelPost?.message_id || ctx?.message?.message_id;
      const message = await this.userRequestService.repository.findOne({
        where: { userRequestChannelMessageId: ctx.channelPost.reply_to_message.message_id },
        relations: { user: true },
      });

      try {
        // убираем реакцию у пользователя
        await this.bot.api.setMessageReaction(message.user.id, message.originalMessageId, []);
      } catch (e) {
        Logger.warn(
          `Cannot remove reaction message for user message for bot ${ctx.me.id}`,
          UserPostManagementService.name
        );
      }

      // копируем ответ пользователю
      await this.bot.api.copyMessage(message.user.id, ctx.chat.id, adminMessageId, {
        reply_to_message_id: message.originalMessageId,
      });

      // Если это текстовое обращение, то после ответа открепляем сообщение
      if (message.isTextRequest) {
        try {
          await this.bot.api.unpinChatMessage(
            this.baseConfigService.userRequestMemeChannel,
            message.userRequestChannelMessageId
          );
        } catch (e) {
          Logger.warn(
            `Cannot unpin text request after admin response for bot ${ctx.me.id}`,
            UserPostManagementService.name
          );
        }
      }
    });
  }

  public async onPublishNow(publishContext: ScheduledPostContextInterface) {
    const message = await this.userRequestService.repository.findOne({
      relations: { user: true },
      where: {
        userRequestChannelMessageId: publishContext.requestChannelMessageId,
      },
    });

    let caption = '';
    if (publishContext.caption) {
      caption += `${publishContext.caption}\n\n`;
    }

    if (publishContext.mode === PublicationModesEnum.NIGHT_CRINGE) {
      const channelHtmlLink = await this.settingsService.cringeChannelHtmlLink();
      caption += channelHtmlLink;
    }

    const publishedMessage = await this.bot.api.copyMessage(
      this.baseConfigService.memeChanelId,
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      {
        caption: caption,
        parse_mode: 'HTML',
        disable_notification: publishContext.caption === PublicationModesEnum.NOW_SILENT,
      }
    );

    await this.userRequestService.repository.update(
      { id: message.id },
      {
        isPublished: true,
        publishedAt: new Date(),
        publishedBy: publishContext.processedByModerator,
        publishedMessageId: publishedMessage.message_id,
      }
    );

    const channelInfo = await this.bot.api.getChat(this.baseConfigService.memeChanelId);
    await this.bot.api.forwardMessage(message.user.id, channelInfo.id, publishedMessage.message_id);

    let userFeedbackMessage = 'Твой пост опубликован \n';
    if (publishContext.mode !== PublicationModesEnum.NIGHT_CRINGE) {
      userFeedbackMessage += 'Присылай еще!\n';
    } else {
      const cringeChannelLink = await this.settingsService.cringeChannelHtmlLink();
      userFeedbackMessage += `Утром пост будет перемещен в канал ${cringeChannelLink}`;
    }

    await this.bot.api.sendMessage(message.user.id, userFeedbackMessage, { parse_mode: 'HTML' });

    const user = await this.userService.repository.findOne({
      where: { id: publishContext.processedByModerator },
    });

    const url = await this.settingsService.channelLinkUrl();
    const inlineKeyboard = new InlineKeyboard().url(`👨 Опубликован (${user.username})`, url).row();

    await this.bot.api.editMessageReplyMarkup(
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      { reply_markup: inlineKeyboard }
    );

    if (publishContext.mode == PublicationModesEnum.NIGHT_CRINGE) {
      await this.cringeManagementService.repository.update(
        { requestChannelMessageId: publishContext.requestChannelMessageId },
        { memeChannelMessageId: publishedMessage.message_id }
      );
    }

    await this.deduplicationService.createPublishedPostHash(
      publishContext.hash,
      publishedMessage.message_id
    );
  }

  private async publishNightCringeScheduled(
    publicContext: ScheduledPostContextInterface
  ): Promise<void> {
    await this.cringeManagementService.repository.insert({
      requestChannelMessageId: publicContext.requestChannelMessageId,
      isUserPost: publicContext.isUserPost,
    });
    await this.publishScheduled(publicContext);
  }

  private async publishScheduled(publishContext: ScheduledPostContextInterface): Promise<void> {
    const publishDate = await this.postSchedulerService.addPostToSchedule(publishContext);

    if (!publishDate) {
      return;
    }

    const dateFormatted = format(
      PostSchedulerService.formatToMsk(publishDate),
      'dd.LL.yy в ~HH:mm'
    );

    const user = await this.userService.repository.findOne({
      where: { id: publishContext.processedByModerator },
    });

    const inlineKeyboard = new InlineKeyboard()
      .text(`⏰ ${dateFormatted} (${user.username})`)
      .row();

    await this.bot.api.editMessageReplyMarkup(
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      { reply_markup: inlineKeyboard }
    );

    const message = await this.userRequestService.repository.findOne({
      relations: { user: true },
      where: {
        userRequestChannelMessageId: publishContext.requestChannelMessageId,
      },
    });

    await this.bot.api.forwardMessage(message.user.id, message.user.id, message.originalMessageId);

    let userFeedbackMessage = `Твой пост будет опубликован ${dateFormatted} ⏱\n\n`;
    if (publishContext.mode === PublicationModesEnum.NIGHT_CRINGE) {
      const cringeChannelLink = await this.settingsService.cringeChannelHtmlLink();
      userFeedbackMessage += `Пост попал в особую рубрику, которая публикуется только ночью, а утром перемещается в отдельный канал: ${cringeChannelLink}\n`;
    }
    userFeedbackMessage += 'Присылай еще 😉️';

    await this.bot.api.sendMessage(message.user.id, userFeedbackMessage, { parse_mode: 'HTML' });

    return Promise.resolve();
  }

  private async onAdminApproveAfterReject(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      relations: { user: true },
      where: {
        userRequestChannelMessageId: ctx.update.callback_query.message.message_id,
      },
    });

    await this.userRequestService.repository.update(
      { id: message.id },
      {
        restoredBy: ctx.config.user.id,
        isApproved: true,
      }
    );

    await this.bot.api.forwardMessage(message.user.id, message.user.id, message.originalMessageId);
    await this.bot.api.sendMessage(
      message.user.id,
      'Мы передумали! 🤯\n\n' +
        'Такое иногда бывает, мы долго думали, смеяли пост со всех сторон, показывали его всем кому могли, ' +
        'в итоге он будет опубликован! 🎉\n' +
        'Прости что так поступили с тобой, в следующий раз мы будем внимательнее. 🥺\n' +
        'P.S. Тебе придет отдельное сообщение, когда пост будет опубликован 😉'
    );
  }

  public async banUser(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
      relations: { user: true },
    });

    await this.userService.repository.update(
      { id: message.user.id },
      {
        isBanned: true,
        bannedBy: ctx.callbackQuery.from.id,
        banUntilTo: add(new Date(), { months: 1 }),
      }
    );

    await this.bot.api.sendMessage(
      message.user.id,
      'К сожалению, мы вынуждены ограничить доступ к боту, т.к. ' +
        'ты серьезно нарушил правила публикации и нашего сообщества, ' +
        'нам жаль что пришлось применить столь серьезную меру, ' +
        'но у нас не осталось иного выхода.\n\n' +
        'Бот больше не будет реагировать на сообщения'
    );
  }

  private async makeUserStrike(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
      relations: { user: true },
    });

    await this.userService.repository.update(
      { id: message.user.id },
      {
        strikes: (message.user.strikes || 0) + 1,
      }
    );
  }

  private async getUserStrikesCount(ctx: BotContext): Promise<number> {
    const message = await this.userRequestService.repository.findOne({
      where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
      relations: { user: true },
    });

    return message.user.strikes;
  }

  private prepareReplyToBotContext(): void {
    this.replyToBotContext = this.bot.filter(async (ctx: BotContext) => {
      if (!ctx?.channelPost?.reply_to_message && !ctx?.message?.reply_to_message) {
        return false;
      }
      const message = await this.userRequestService.repository.findOne({
        where: {
          userRequestChannelMessageId:
            ctx?.channelPost?.reply_to_message?.message_id ||
            ctx?.message?.reply_to_message?.message_id,
        },
      });
      return !!message;
    });
  }
}
