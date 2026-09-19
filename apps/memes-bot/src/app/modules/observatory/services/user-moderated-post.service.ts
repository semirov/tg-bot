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
import {ModerationRoundPolicy} from './moderation-round-policy';

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

  /** Чистая политика решения раунда пользовательской модерации. */
  private readonly moderationRoundPolicy = new ModerationRoundPolicy();

  private userModeratedPostSubject = new Subject<ScheduledPostContextInterface>();

  public get userModeratedPost$(): Observable<ScheduledPostContextInterface> {
    return this.userModeratedPostSubject.asObservable();
  }

  public buildUserModeratePost(): Menu<BotContext> {
    this.moderatePostMenu = new Menu<BotContext>('USER_POST_MODERATE')
      .text('👍', async (ctx) => this.processUserVote(ctx, true))
      .text('👎', async (ctx) => this.processUserVote(ctx, false))
      .row()
      .text('Не хочу оценивать посты', (ctx) => this.discardModerateByUser(ctx))
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
      await ctx.reply(
        'Если снова захочешь оценивать посты, то можешь включить это в настройках\n' +
        '"Меню" -> "Настройки" -> "Не оцениваю посты"\n'
      );
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
      hash: publishContext.hash,
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
      await this.processUserModerateMessage(ctx, user.id, publishContext);
    }
  }

  private async processUserModerateMessage(
    ctx: BotContext,
    userId: number,
    publishContext: ScheduledPostContextInterface
  ): Promise<void> {
    try {

      const message = await ctx.api.copyMessage(
        userId,
        this.baseConfigService.userRequestMemeChannel,
        publishContext.requestChannelMessageId,
        {reply_markup: this.moderatePostMenu}
      );

      await this.userMessageModeratedPostEntity.insert({
        userId,
        userMessageId: message.message_id,
        requestChannelMessageId: publishContext.requestChannelMessageId,
      });
    } catch (e) {
      await this.userService.changeUserModeratedMode(userId, false);
    } finally {
      await firstValueFrom(timer(1000));
    }
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
    ctx.session.userVoted = true;
    if (moderatedMessage.isRejected || moderatedMessage.isApproved) {
      try {
        await ctx.editMessageReplyMarkup({reply_markup: this.endModerateKeyboard});
      } catch (e) {
        /**/
      }
    }
    const likes = isLike ? +moderatedMessage.likes + 1 : +moderatedMessage.likes;
    const dislikes = !isLike ? +moderatedMessage.dislikes + 1 : +moderatedMessage.dislikes;

    await this.userModeratedPostEntity.update(
      {id: moderatedMessage.id},
      {
        likes,
        dislikes,
      }
    );
    await this.userMessageModeratedPostEntity.update(
      {
        userId: ctx.callbackQuery.from.id,
        requestChannelMessageId: moderatedMessage.requestChannelMessageId,
      },
      {voted: true}
    );
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

    const round = this.moderationRoundPolicy.decide({
      likes: post.likes,
      dislikes: post.dislikes,
    });

    if (round.isApproved) {
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

    const userMessages = await this.userMessageModeratedPostEntity.find({
      where: {requestChannelMessageId: post.requestChannelMessageId},
    });

    for (const user of userMessages) {
      try {
        const menu = this.moderationRoundPolicy.buildUserResultKeyboard(round);
        await this.bot.api.editMessageReplyMarkup(user.userId, user.userMessageId, {
          reply_markup: menu,
        });
      } catch (e) {
        //
      }
    }
  }

}
