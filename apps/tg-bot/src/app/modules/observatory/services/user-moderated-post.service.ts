import {Inject, Injectable} from '@nestjs/common';
import {ScheduledPostContextInterface} from '../../bot/services/post-scheduler.service';
import {UserService} from '../../bot/services/user.service';
import {Menu, MenuFlavor} from '@grammyjs/menu';
import {BotContext} from '../../bot/interfaces/bot-context.interface';
import {BOT} from '../../bot/providers/bot.provider';
import {Bot, InlineKeyboard} from 'grammy';
import {InjectRepository} from '@nestjs/typeorm';
import {UserModeratedPostEntity} from '../entities/user-moderated-post.entity';
import {LessThanOrEqual, Repository} from 'typeorm';
import {UserMessageModeratedPostEntity} from '../entities/user-message-moderated-post.entity';
import {BaseConfigService} from '../../config/base-config.service';
import {UserEntity} from '../../bot/entities/user.entity';
import {add} from 'date-fns';
import {firstValueFrom, Observable, Subject, timer} from 'rxjs';
import {Interval} from '@nestjs/schedule';

@Injectable()
export class UserModeratedPostService {
  constructor(
    @InjectRepository(UserModeratedPostEntity)
    private userModeratedPostEntity: Repository<UserModeratedPostEntity>,
    @InjectRepository(UserMessageModeratedPostEntity)
    private userMessageModeratedPostEntity: Repository<UserMessageModeratedPostEntity>,
    private userService: UserService,
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService
  ) {
  }

  @Interval(60000)
  async handleCron() {
    await this.handleNextUserModeratedPost();
  }

  /**
   * Меню публикации одобренного поста
   */
  private moderatePostMenu: Menu<BotContext>;

  private endModerateKeyboard = new InlineKeyboard().text('Спасибо! 😌').row();

  private userModeratedPostSubject = new Subject<ScheduledPostContextInterface>();

  public get userModeratedPost$(): Observable<ScheduledPostContextInterface> {
    return this.userModeratedPostSubject.asObservable();
  }

  public buildUserModeratePost(): Menu<BotContext> {
    this.moderatePostMenu = new Menu<BotContext>('USER_POST_MODERATE')
      .text('👍', async (ctx) => this.processUserVote(ctx, true))
      .text('👎', async (ctx) => this.processUserVote(ctx, false))
      .row()
      .text('Не хочу оценивать мемы', (ctx) => this.discardModerateByUser(ctx))
      .row();

    return this.moderatePostMenu;
  }

  private async discardModerateByUser(ctx: BotContext & MenuFlavor) {
    ctx.session.canBeModeratePosts = false;
    await this.userService.changeUserModeratedMode(ctx.from.id, false);
    const moderatedMessage = await this.getModeratedContextByCtx(ctx);
    await this.userModeratedPostEntity.update(
      {id: moderatedMessage.id},
      {moderatedUsersCount: moderatedMessage.moderatedUsersCount - 1}
    );
    try {
      await ctx.editMessageReplyMarkup({reply_markup: this.endModerateKeyboard});
      await ctx.reply('Жаль 😞\nЕсли снова захочешь оценивать мемы, то можешь включить это в настройках\n' +
        '"Меню" -> "Настройки" -> "Не оцениваю мемы"\n');
    } catch (e) {
      /**/
    }
  }

  public async moderateViaUsers(
    ctx: BotContext,
    publishContext: ScheduledPostContextInterface
  ): Promise<number> {
    const users = await this.userService.getUsersForPostModerate();

    await this.userModeratedPostEntity.insert({
      requestChannelMessageId: publishContext.requestChannelMessageId,
      mode: publishContext.mode,
      isApproved: false,
      processedByModerator: publishContext.processedByModerator,
      caption: publishContext.caption,
      moderatedTo: add(new Date(), {hours: 2}),
      moderatedUsersCount: users.length,
    });
    this.processUsersModerate(users, ctx, publishContext);
    return users.length;
  }

  private async processUsersModerate(
    users: Pick<UserEntity, 'id'>[],
    ctx: BotContext,
    publishContext: ScheduledPostContextInterface
  ) {
    for (const user of users) {
      await this.processUserModerateMessage(ctx, user, publishContext);
    }
  }

  private async processUserModerateMessage(
    ctx: BotContext,
    user: Pick<UserEntity, 'id'>,
    publishContext: ScheduledPostContextInterface
  ): Promise<void> {
    await ctx.api.sendMessage(
      user.id,
      'Привет!\nОцени пожалуйста этот мем 😌\n' +
      'Админ не смог определиться смешной он или нет, поэтому просим помощи у тебя\n' +
      'Если не хочешь чтобы тебя просили оценивать мемы, нажми кнопку "Не хочу оценивать мемы" ' +
      'и больше таких сообщений не будет'
    );
    try {
      const message = await ctx.api.copyMessage(
        user.id,
        this.baseConfigService.userRequestMemeChannel,
        publishContext.requestChannelMessageId,
        {reply_markup: this.moderatePostMenu}
      );

      await this.userMessageModeratedPostEntity.insert({
        userId: user.id,
        userMessageId: message.message_id,
        requestChannelMessageId: publishContext.requestChannelMessageId,
      });
    } catch (e) {
      await this.userService.changeUserModeratedMode(ctx.from.id, false);
    }

    await firstValueFrom(timer(500));
  }

  private async getModeratedContextByCtx(ctx: BotContext): Promise<UserModeratedPostEntity> {
    const userRequestMessageId = await this.userMessageModeratedPostEntity.findOne({
      where: {userMessageId: ctx.callbackQuery.message.message_id},
    });
    return this.userModeratedPostEntity.findOne({
      where: {requestChannelMessageId: userRequestMessageId.requestChannelMessageId},
    });
  }

  private async processUserVote(ctx: BotContext & MenuFlavor, isLike: boolean): Promise<void> {
    const moderatedMessage = await this.getModeratedContextByCtx(ctx);
    if (moderatedMessage.isRejected || moderatedMessage.isApproved) {
      try {
        await ctx.editMessageReplyMarkup({reply_markup: this.endModerateKeyboard});
      } catch (e) {
        /**/
      }
    }
    const likes = isLike ? +moderatedMessage.likes + 1 : +moderatedMessage.likes;
    const dislikes = !isLike ? +moderatedMessage.dislikes + 1 : +moderatedMessage.dislikes;
    const usersCount = +moderatedMessage.moderatedUsersCount;
    const votesCount = likes + dislikes;

    await this.userModeratedPostEntity.update(
      {id: moderatedMessage.id},
      {
        likes,
        dislikes,
      }
    );
    if (likes > dislikes && votesCount >= +usersCount / 2) {
      await this.userModeratedPostEntity.update({id: moderatedMessage.id}, {isApproved: true});
      this.userModeratedPostSubject.next({
        mode: moderatedMessage.mode,
        requestChannelMessageId: moderatedMessage.requestChannelMessageId,
        processedByModerator: moderatedMessage.processedByModerator,
        caption: moderatedMessage.caption,
        isUserPost: false,
        hash: moderatedMessage.hash,
      });
    }
    try {
      await ctx.editMessageReplyMarkup({reply_markup: this.endModerateKeyboard});
    } catch (e) {
      /**/
    }
  }

  private async handleNextUserModeratedPost(): Promise<void> {
    const post = await this.userModeratedPostEntity.findOne({
      where: {
        isApproved: false,
        isRejected: false,
        moderatedTo: LessThanOrEqual(new Date()),
      },
      order: {moderatedTo: 'ASC'},
    });

    if (!post) {
      return;
    }

    if (+post.likes >= +post.dislikes || +post.dislikes === 0) {
      await this.userModeratedPostEntity.update({id: post.id}, {isApproved: true});
      this.userModeratedPostSubject.next({
        mode: post.mode,
        requestChannelMessageId: post.requestChannelMessageId,
        processedByModerator: post.processedByModerator,
        caption: post.caption,
        isUserPost: false,
        hash: post.hash,
      });
    } else {
      await this.userModeratedPostEntity.update({id: post.id}, {isRejected: true});
    }
  }
}
