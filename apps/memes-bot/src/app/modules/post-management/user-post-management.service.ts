import { Menu } from '@grammyjs/menu';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { add, format, formatDistance } from 'date-fns';
import { ru } from 'date-fns/locale';
import { Bot, Composer, InlineKeyboard } from 'grammy';
import { UserPermissionEnum } from '../bot/constants/user-permission.enum';
import { BotContext } from '../bot/interfaces/bot-context.interface';
import { BOT } from '../bot/providers/bot.provider';
import { CringeManagementService } from '../bot/services/cringe-management.service';
import { DeduplicationService } from '../bot/services/deduplication.service';
import {
  PostSchedulerService,
  ScheduledPostContextInterface,
} from '../bot/services/post-scheduler.service';
import { SettingsService } from '../bot/services/settings.service';
import { UserRequestService } from '../bot/services/user-request.service';
import { UserService } from '../bot/services/user.service';
import { ClientBaseService } from '../client/services/client-base.service';
import { BaseConfigService } from '../config/base-config.service';
import { MattermostService } from '../mattermost/mattermost.service';
import { TrollService } from '../troll/services/troll.service';
import { PostModerationMenusEnum } from './constants/post-moderation-menus.enum';
import { PublicationModesEnum } from './constants/publication-modes.enum';
import { resolveAdminReply } from './utils/admin-reply';
import { buildTelegramFileUrl, extractTelegramFileId } from '../../shared/publication/media-url';
import { sendPostToMattermost } from '../../shared/publication/mattermost-post';
import { runPublicationMode } from '../../shared/publication/publication-mode';
import {
  DuplicatePolicy,
  pickClosest,
  ScheduledDuplicate,
} from './services/duplicate-policy';
import { UserPostFormatter } from './services/user-post-formatter';

@Injectable()
export class UserPostManagementService implements OnModuleInit {
  private readonly logger = new Logger(UserPostManagementService.name);

  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userService: UserService,
    private userRequestService: UserRequestService,
    private postSchedulerService: PostSchedulerService,
    private settingsService: SettingsService,
    private cringeManagementService: CringeManagementService,
    private deduplicationService: DeduplicationService,
    private clientBaseService: ClientBaseService,
    private mattermostService: MattermostService,
    private trollService: TrollService
  ) {
    this.duplicatePolicy = new DuplicatePolicy(postSchedulerService, deduplicationService);
  }

  private moderatedPostMenu: Menu<BotContext>;
  private replyToBotContext: Composer<BotContext>;
  private duplicateMenu: Menu<BotContext>;

  private limitMenu: Menu<BotContext>;

  /** Политика дубликатов (порог схожести, даты, запланированные посты). */
  private readonly duplicatePolicy: DuplicatePolicy;

  /** Чистые форматтеры текстов предложки. */
  private readonly formatter = new UserPostFormatter();

  public onModuleInit(): void {
    this.buildModeratedPostMenu();
    this.buildDuplicateMenu(); // Добавляем создание меню для дубликатов
    this.limitMenu = this.buildLimitMenu();
    this.bot.use(this.limitMenu);
    this.prepareReplyToBotContext();
    this.handleAdminUserResponse();
    this.observeDailyBesetMemes();

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
          this.formatter.limitLiftedByModeratorText(
            ctx.callbackQuery.message.text,
            ctx.callbackQuery.from.username
          ),
          { reply_markup: null }
        );
      } catch (error) {
        Logger.error(`Failed to lift limit: ${error.message}`, UserPostManagementService.name);
        await ctx.answerCallbackQuery('Ошибка при снятии лимита');
      }
    });
  }

  public observeDailyBesetMemes(): void {
    this.clientBaseService.bestMemesDaily$.subscribe(async (ctx) => {
      const { byLikePostMemeId, byViewPostMemeId } = ctx;

      // Собираем все ID лучших постов
      const bestPostIds = [byLikePostMemeId, byViewPostMemeId].filter(
        (id) => id !== undefined
      ) as number[];

      // Лучших нет (ошибка сбора/пустой день) — уведомлять некого.
      // Без этой проверки `IN ()` в SQL падает с syntax error.
      if (!bestPostIds.length) {
        return;
      }

      // Находим посты в user-request.entity по publishedMessageId
      const bestUserPosts = await this.userRequestService.repository
        .createQueryBuilder('userRequest')
        .leftJoinAndSelect('userRequest.user', 'user')
        .where('userRequest.publishedMessageId IN (:...ids)', { ids: bestPostIds })
        .andWhere('userRequest.isPublished = :isPublished', { isPublished: true })
        .getMany();

      // Группируем посты по пользователям
      const postsByUser = new Map<number, typeof bestUserPosts>();
      for (const post of bestUserPosts) {
        if (post.user) {
          let userPosts = postsByUser.get(post.user.id);
          if (!userPosts) {
            userPosts = [];
            postsByUser.set(post.user.id, userPosts);
          }
          userPosts.push(post);
        }
      }

      // Для каждого пользователя отправляем уведомление и репостим посты
      for (const [userId, userPosts] of postsByUser) {
        try {
          // Формируем сообщение для пользователя
          const messageText = this.formatter.bestMemesText(userPosts.length);

          const keyboard = new InlineKeyboard();

          const bestMemeUrl = await this.settingsService.channelBestLinkUrl();
          const bestChannelName = await this.settingsService.channelBestChannelName();

          keyboard.url(bestChannelName, bestMemeUrl);

          // Отправляем уведомление пользователю
          await this.bot.api.sendMessage(userId, messageText, { reply_markup: keyboard });

          // Репостим каждый пост пользователя
          for (const post of userPosts) {
            if (post.publishedMessageId) {
              await this.bot.api.forwardMessage(
                userId,
                this.baseConfigService.memeChanelId,
                post.publishedMessageId
              );
            }
          }
        } catch (error) {
          Logger.error(
            `Failed to notify user ${userId} about best post: ${error.message}`,
            UserPostManagementService.name
          );
        }
      }
    });
  }

  public async handleUserTextRequest(ctx: BotContext): Promise<void> {
    try {
      await ctx.react('👍');
    } catch (e) {
      await ctx.reply(this.formatter.requestReactionAckText());
      Logger.warn(
        `Cannot set message reaction for user text message in bot ${ctx.me.id}`,
        UserPostManagementService.name
      );
    }

    const user = await this.userService.repository.findOne({
      where: { id: ctx.message.from.id },
    });

    // Формируем текст для обращения
    const userText = this.formatter.textRequestText(ctx.message.from);

    // Отправляем информацию о пользователе в канал запросов
    await this.bot.api.sendMessage(this.baseConfigService.userRequestMemeChannel, userText, {
      disable_notification: true,
    });

    // Если это ответ на сообщение, сначала пересылаем сообщение, на которое ответил пользователь
    if (ctx.message.reply_to_message) {
      try {
        // Отправляем сообщение, на которое ответил пользователь
        await ctx.api.forwardMessage(
          this.baseConfigService.userRequestMemeChannel,
          ctx.message.chat.id,
          ctx.message.reply_to_message.message_id
        );

        // Добавляем уточнение, что пользователь ответил на это сообщение
        await this.bot.api.sendMessage(
          this.baseConfigService.userRequestMemeChannel,
          this.formatter.adminReplyHintText(),
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
          this.formatter.adminReplyForwardFailedText(),
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
      UserPostFormatter.LIFT_LIMIT_LABEL,
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
              if (this.duplicatePolicy.hasSimilar(duplicates)) {
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

          // Отправляем пользователю уведомление с его постом
          await this.bot.api.forwardMessage(
            message.user.id,
            this.baseConfigService.userRequestMemeChannel,
            ctx.callbackQuery.message.message_id
          );

          await this.bot.api.sendMessage(
            message.user.id,
            this.formatter.limitLiftedForUserText(),
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

      // Получаем пользователя
      const user = await this.userService.repository.findOne({
        where: { id: ctx.message.from.id },
      });

      // Получаем fileUniqueId для изображения, если оно есть
      let fileUniqueId = null;
      if (ctx.message?.photo) {
        fileUniqueId = ctx.message.photo[ctx.message.photo.length - 1].file_unique_id;
      }

      const now = new Date();
      const isLimitDisabled = user.memeLimitDisabledUntil && now < user.memeLimitDisabledUntil;
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

        const message = this.formatter.limitReachedText(remainingTime);

        await ctx.reply(message, {
          reply_to_message_id: ctx.message.message_id,
          parse_mode: 'HTML',
        });

        // Сохраняем запрос в БД без проверки на дубликаты
        const savedRequest = await this.userRequestService.repository.insert({
          user: user,
          isAnonymousPublishing: false,
          originalMessageId: ctx.message.message_id,
          userRequestChannelMessageId: null,
          possibleDuplicate: false,
          fileUniqueId: fileUniqueId, // Добавляем fileUniqueId в запись
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

        // Закрепляем сообщение в канале запросов
        await this.bot.api.pinChatMessage(
          this.baseConfigService.userRequestMemeChannel,
          channelMessage.message_id,
          { disable_notification: true }
        );

        // Показываем меню с кнопкой снятия лимита
        await ctx.api.editMessageReplyMarkup(
          this.baseConfigService.userRequestMemeChannel,
          channelMessage.message_id,
          { reply_markup: this.buildLimitMenu() }
        );
        return;
      }

      // Проверяем, есть ли уже пост с таким fileUniqueId перед выполнением любых других действий
      if (fileUniqueId) {
        const existingPost = await this.userRequestService.repository.findOne({
          where: { fileUniqueId: fileUniqueId },
        });

        if (existingPost) {
          // Выводим информацию в консоль
          Logger.log(
            `Найден пост с таким же fileUniqueId: ${fileUniqueId}. ID существующего поста: ${existingPost.id}`,
            UserPostManagementService.name
          );

          // Проверяем статус существующего поста
          const statusMessage = this.formatter.duplicateStatusText(existingPost);

          // Автоматически отклоняем пост
          await ctx.reply(statusMessage, {
            reply_to_message_id: ctx.message.message_id,
          });

          // Сохраняем информацию о запросе в БД с отметкой об отклонении
          await this.userRequestService.repository.insert({
            user: user,
            isAnonymousPublishing: false,
            originalMessageId: ctx.message.message_id,
            userRequestChannelMessageId: null,
            fileUniqueId: fileUniqueId,
            isApproved: false,
            isDuplicate: true,
          });

          await this.userService.updateUserLastActivity(ctx);
          return;
        }
      }

      // Проверка лимита мемов (сообщений с медиа: изображения/видео) для всех пользователей
      // Добавляем подробное логирование для отладки
      Logger.log(
        `Checking meme limit for user ${user.id} (${user.username || 'no username'})`,
        UserPostManagementService.name
      );

      // Логируем случаи переопределения лимита
      if (isLimitDisabled) {
        Logger.log(
          `User ${user.id} posted with disabled limit (until ${user.memeLimitDisabledUntil})`,
          UserPostManagementService.name
        );
      }
    } catch (e) {
      await ctx.reply(this.formatter.requestReceivedText());
      Logger.warn(
        `Cannot set message reaction for user message in bot ${ctx.me.id}`,
        UserPostManagementService.name
      );
    }

    // Получаем пользователя еще раз после блока try-catch
    const user = await this.userService.repository.findOne({
      where: { id: ctx.message.from.id },
    });

    // Получаем fileUniqueId для изображения, если оно есть (повторно, так как переменная может быть недоступна)
    let fileUniqueId = null;
    if (ctx.message?.photo) {
      fileUniqueId = ctx.message.photo[ctx.message.photo.length - 1].file_unique_id;
    }

    let userText = this.formatter.memeRequestText(ctx.message.from);

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

        if (this.duplicatePolicy.hasSimilar(duplicates)) {
          // Находим лучшее совпадение
          bestMatch = pickClosest(duplicates);

          // Форматируем процент совпадения
          const matchPercentage = Math.round(bestMatch.distance * 100);

          // Добавляем информацию о дубликате в текст сообщения
          userText += this.formatter.publishedDuplicateNote(matchPercentage);
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
              userText += this.formatter.scheduledDuplicateOnDateNote(
                matchPercentage,
                formattedDate
              );
            } catch (error) {
              // В случае ошибки форматирования, используем более простой вариант
              userText += this.formatter.scheduledDuplicateSoonNote(matchPercentage);
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
            this.formatter.scheduledDuplicateInfoText(
              formattedDate,
              timeDistance,
              scheduledDuplicate.postId
            ),
            { disable_notification: true }
          );
        } else {
          // Если дата невалидна, отправляем сообщение без форматирования
          await this.bot.api.sendMessage(
            this.baseConfigService.userRequestMemeChannel,
            this.formatter.scheduledDuplicateInfoSoonText(scheduledDuplicate.postId),
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
      fileUniqueId: fileUniqueId,
    });

    await this.userService.updateUserLastActivity(ctx);
  }

  /**
   * Проверяет наличие похожих постов среди запланированных
   */
  private async checkScheduledDuplicates(hash: string): Promise<ScheduledDuplicate | null> {
    return this.duplicatePolicy.checkScheduledDuplicates(hash);
  }

  // Вспомогательная функция для проверки валидности даты
  private isValidDate(date: Date | string | number): boolean {
    return this.duplicatePolicy.isValidDate(date);
  }

  // Обновляем метод buildDuplicateMenu, чтобы он также мог обрабатывать запланированные дубликаты
  private buildDuplicateMenu() {
    return new Menu<BotContext>('duplicate-check-menu', { autoAnswer: false })
      .text(UserPostFormatter.DUPLICATE_CONFIRM_LABEL, async (ctx) => {
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
                this.formatter.duplicateScheduledToUserText(scheduledDateFormatted),
                { reply_to_message_id: message.originalMessageId }
              );
            } else {
              // Стандартное сообщение, если не удалось получить детали о запланированном посте
              await this.bot.api.sendMessage(
                message.user.id,
                this.formatter.duplicateScheduledSoonToUserText()
              );
            }
          } else {
            // Стандартное сообщение для дубликата опубликованного поста
            await this.bot.api.sendMessage(
              message.user.id,
              this.formatter.publishedDuplicateToUserText()
            );

            // Находим дубликат снова и пересылаем его
            const hash = await this.deduplicationService.getPostImageHash(
              ctx.callbackQuery.message.photo
            );
            if (hash) {
              const duplicates = await this.deduplicationService.checkDuplicate(hash);
              if (duplicates.length > 0) {
                const bestMatch = pickClosest(duplicates);

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
      .text(UserPostFormatter.DUPLICATE_DENY_LABEL, async (ctx) => {
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
      .text(UserPostFormatter.APPROVE_LABEL, async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          await this.onModeratorApprovalActions(ctx);
          ctx.menu.nav(PostModerationMenusEnum.APPROVAL);
        }
      })
      .text(UserPostFormatter.REJECT_LABEL, async (ctx) => {
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
          return this.formatter.publishButtonLabel(message.processedByModerator.username);
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
        return this.formatter.discardStatisticLabel(statistic.total, statistic.week);
      })
      .text(async (ctx) => {
        const statistic = await this.userRequestService.userPostApprovedStatistic(ctx);
        return this.formatter.approvedStatisticLabel(statistic.total, statistic.day);
      })
      .text(async (ctx) => {
        const lastPostInfo = await this.userRequestService.lastPublishedPostTimeAgo(ctx);
        return this.formatter.lastPostLabel(lastPostInfo);
      })
      .row();

    const publishSubmenu = new Menu<BotContext>(PostModerationMenusEnum.PUBLICATION, {
      autoAnswer: false,
    })
      .text(UserPostFormatter.PUBLISH_NIGHT_CRINGE_LABEL, async (ctx) =>
        this.onPublishActions(ctx, PublicationModesEnum.NIGHT_CRINGE)
      )
      .text(UserPostFormatter.PUBLISH_NOW_LABEL, async (ctx) =>
        this.onPublishActions(ctx, PublicationModesEnum.NOW_SILENT)
      )
      .row()
      .text(UserPostFormatter.PUBLISH_NEXT_INTERVAL_LABEL, async (ctx) =>
        this.onPublishActions(ctx, PublicationModesEnum.NEXT_INTERVAL)
      )
      .row()
      .text(UserPostFormatter.PUBLISH_NIGHT_LABEL, async (ctx) =>
        this.onPublishActions(ctx, PublicationModesEnum.NEXT_NIGHT)
      )
      .text(UserPostFormatter.PUBLISH_MORNING_LABEL, async (ctx) =>
        this.onPublishActions(ctx, PublicationModesEnum.NEXT_MORNING)
      )
      .text(UserPostFormatter.PUBLISH_MIDDAY_LABEL, async (ctx) =>
        this.onPublishActions(ctx, PublicationModesEnum.NEXT_MIDDAY)
      )
      .text(UserPostFormatter.PUBLISH_EVENING_LABEL, async (ctx) =>
        this.onPublishActions(ctx, PublicationModesEnum.NEXT_EVENING)
      )
      .row()
      .text(UserPostFormatter.BACK_LABEL, (ctx) =>
        ctx.menu.nav(PostModerationMenusEnum.APPROVAL)
      );

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
          return this.formatter.rejectedButtonLabel(message.processedByModerator.username);
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
      .text(UserPostFormatter.RESTORE_LABEL, async (ctx) => {
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
          return this.formatter.strikesLabel(stikesCount);
        },
        async (ctx) => {
          if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_SET_STRIKE)) {
            ctx.menu.nav(PostModerationMenusEnum.STRIKE);
          }
        }
      )
      .text(UserPostFormatter.BAN_LABEL, async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_MAKE_BAN)) {
          await this.onAdminApproveAfterReject(ctx);
          ctx.menu.nav(PostModerationMenusEnum.BAN);
        }
      })
      .row();

    const banConfirmation = new Menu<BotContext>(PostModerationMenusEnum.BAN, { autoAnswer: false })
      .text(UserPostFormatter.BAN_CONFIRM_LABEL, async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_MAKE_BAN)) {
          await this.banUser(ctx);
          await ctx.deleteMessage();
        }
        return;
      })
      .text(UserPostFormatter.NO_LABEL, async (ctx) => {
        ctx.menu.nav(PostModerationMenusEnum.REJECT);
      })
      .row();

    const strikeConfirmation = new Menu<BotContext>(PostModerationMenusEnum.STRIKE, {
      autoAnswer: false,
    })
      .text(UserPostFormatter.STRIKE_CONFIRM_LABEL, async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_SET_STRIKE)) {
          await this.makeUserStrike(ctx);
          ctx.menu.nav(PostModerationMenusEnum.REJECT);
        }
      })
      .text(UserPostFormatter.NO_LABEL, async (ctx) => {
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
    this.registerScheduleCallbacks();

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

    // Получаем fileUniqueId из сообщения в канале модераторов
    let fileUniqueId = null;
    if (ctx.callbackQuery?.message?.photo) {
      fileUniqueId =
        ctx.callbackQuery.message.photo[ctx.callbackQuery.message.photo.length - 1].file_unique_id;
    }

    await this.userRequestService.repository.update(
      { id: message.id },
      {
        fileUniqueId,
        isApproved: false,
        processedByModerator: { id: ctx.callbackQuery.from.id },
        moderatedAt: new Date(),
      }
    );
    await this.bot.api
      .forwardMessage(message.user.id, message.user.id, message.originalMessageId)
      .catch();
    await this.bot.api.sendMessage(message.user.id, this.formatter.rejectedPostText());
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

    return runPublicationMode(
      mode,
      {
        now: (context: ScheduledPostContextInterface) => this.onPublishNow(context),
        scheduled: (context: ScheduledPostContextInterface) => this.publishScheduled(context),
        nightCringe: (context: ScheduledPostContextInterface) =>
          this.publishNightCringeScheduled(context),
      },
      publishContext
    );
  }

  private handleAdminUserResponse(): void {
    this.replyToBotContext.on(['message', 'channel_post'], async (ctx) => {
      const reply = resolveAdminReply(ctx, this.baseConfigService.userRequestMemeChannel);

      if (!reply) {
        return;
      }

      const message = await this.userRequestService.repository.findOne({
        where: { userRequestChannelMessageId: reply.replyToMessageId },
        relations: { user: true },
      });

      if (!message?.user) {
        Logger.warn(
          `Ответ админа игнорирован: заявка на сообщение ${reply.replyToMessageId} не найдена`,
          UserPostManagementService.name
        );
        return;
      }

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
      await this.bot.api.copyMessage(message.user.id, reply.chatId, reply.adminMessageId, {
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

    const userFeedbackMessage =
      publishContext.mode === PublicationModesEnum.NIGHT_CRINGE
        ? this.formatter.postPublishedNightCringeText(
            await this.settingsService.cringeChannelHtmlLink()
          )
        : this.formatter.postPublishedText();

    await this.bot.api.sendMessage(message.user.id, userFeedbackMessage, { parse_mode: 'HTML' });

    const user = await this.userService.repository.findOne({
      where: { id: publishContext.processedByModerator },
    });

    const url = await this.settingsService.channelLinkUrl();
    const inlineKeyboard = new InlineKeyboard()
      .url(this.formatter.publishedKeyboardLabel(user.username), url)
      .row();

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

    // Иногда репостим новый мем в активные чаты (не блокирует публикацию).
    void this.trollService.maybeRepostMeme(
      this.baseConfigService.memeChanelId,
      publishedMessage.message_id
    );
  }

  /**
   * Отправляет пост в Mattermost параллельно с основной публикацией в Telegram.
   */
  private async sendToMattermost(requestChannelMessageId: number, caption: string): Promise<void> {
    return sendPostToMattermost({
      mattermostService: this.mattermostService,
      getFileUrl: (messageId) => this.getTelegramFileUrl(messageId),
      logger: this.logger,
      requestChannelMessageId,
      caption,
      fileNamePrefix: 'meme_',
    });
  }

  /**
   * Получает прямую ссылку на файл из Telegram по ID сообщения в буферном канале.
   * Использует grammy bot.api.forwardMessage для получения структуры сообщения с file_id.
   */
  private async getTelegramFileUrl(messageId: number): Promise<string | undefined> {
    try {
      const chatId = this.baseConfigService.userRequestMemeChannel;
      const token = this.baseConfigService.botToken;

      // Используем bot.api.forwardMessage чтобы получить структуру сообщения
      // (возвращает Message с photo/video/document и file_id)
      const forwarded = await this.bot.api.forwardMessage(chatId, chatId, messageId, {
        disable_notification: true,
      });

      const fileId = extractTelegramFileId(forwarded);

      if (!fileId) return undefined;

      const file = await this.bot.api.getFile(fileId);
      if (!file?.file_path) return undefined;

      return buildTelegramFileUrl(token, file.file_path, this.baseConfigService.tgEnv);
    } catch (error) {
      this.logger.error('Failed to get Telegram file URL:', error);
      return undefined;
    }
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

    const inlineKeyboard = this.scheduledStatusKeyboard(
      Number(publishContext.requestChannelMessageId),
      dateFormatted,
      user.username,
      publishContext.mode === PublicationModesEnum.NIGHT_CRINGE
    );

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

    let userFeedbackMessage = this.formatter.postScheduledText(dateFormatted);
    if (publishContext.mode === PublicationModesEnum.NIGHT_CRINGE) {
      const cringeChannelLink = await this.settingsService.cringeChannelHtmlLink();
      userFeedbackMessage = this.formatter.postScheduledNightCringeText(
        dateFormatted,
        cringeChannelLink
      );
    }

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
    await this.bot.api.sendMessage(message.user.id, this.formatter.restoredAfterRejectText());
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

    await this.bot.api.sendMessage(message.user.id, this.formatter.bannedUserText());
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
      const reply = resolveAdminReply(ctx, this.baseConfigService.userRequestMemeChannel);

      if (!reply) {
        return false;
      }

      const message = await this.userRequestService.repository.findOne({
        where: {
          userRequestChannelMessageId: reply.replyToMessageId,
        },
      });
      return !!message;
    });
  }

  /** Статусная клавиатура запланированного поста: время, куда, снять. */
  public scheduledStatusKeyboard(
    messageId: number,
    dateFormatted: string,
    username: string | null,
    isCringe: boolean
  ): InlineKeyboard {
    const who = username ? ` · @${username}` : '';
    const where = isCringe ? '📍 кринж (ночь)' : '📍 основной';
    return new InlineKeyboard()
      .disabled(`⏰ ${dateFormatted}${who} · ${where}`)
      .row()
      .text('🚫 Снять с публикации', `upsched:unsch:${messageId}`).danger();
  }

  /** Снятие с публикации: подтверждение и возврат карточки в модерацию. */
  private registerScheduleCallbacks(): void {
    const channel = this.baseConfigService.userRequestMemeChannel;
    const allowed = (ctx: BotContext): boolean =>
      this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR);

    this.bot.callbackQuery(/^upsched:unsch:(\d+)$/, async (ctx) => {
      if (!allowed(ctx)) return ctx.answerCallbackQuery('Нет прав');
      await ctx.answerCallbackQuery('Снять с публикации?');
      const id = ctx.match?.[1];
      await this.bot.api.editMessageReplyMarkup(channel, Number(id), {
        reply_markup: new InlineKeyboard()
          .text('✅ Снять', `upsched:unschok:${id}`)
          .text('↩️ Отмена', `upsched:unschcancel:${id}`),
      });
    });

    this.bot.callbackQuery(/^upsched:unschcancel:(\d+)$/, async (ctx) => {
      if (!allowed(ctx)) return ctx.answerCallbackQuery('Нет прав');
      const id = Number(ctx.match?.[1]);
      await ctx.answerCallbackQuery('Оставлено');
      const entry = await this.postSchedulerService.findByRequestMessageId(id);
      if (entry?.publishDate) {
        const dateFormatted = format(
          PostSchedulerService.formatToMsk(entry.publishDate),
          'dd.LL.yy в ~HH:mm'
        );
        await this.bot.api.editMessageReplyMarkup(channel, id, {
          reply_markup: this.scheduledStatusKeyboard(
            id,
            dateFormatted,
            null,
            entry.mode === PublicationModesEnum.NIGHT_CRINGE
          ),
        });
      }
    });

    this.bot.callbackQuery(/^upsched:unschok:(\d+)$/, async (ctx) => {
      if (!allowed(ctx)) return ctx.answerCallbackQuery('Нет прав');
      const id = Number(ctx.match?.[1]);
      const removed = await this.postSchedulerService.removeByRequestMessageId(id);
      if (removed) {
        await this.cringeManagementService.repository
          .delete({ requestChannelMessageId: id })
          .catch(() => undefined);
      }
      await this.bot.api.editMessageReplyMarkup(channel, id, {
        reply_markup: this.moderatedPostMenu,
      });
      await ctx.answerCallbackQuery(removed ? 'Снято с публикации' : 'Уже снято');
    });
  }
}
