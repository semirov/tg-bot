import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InsertResult, Repository } from 'typeorm';
import { UserPermissionEnum } from '../constants/user-permission.enum';
import { UserEntity } from '../entities/user.entity';
import { BotContext } from '../interfaces/bot-context.interface';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>
  ) {}

  public get repository(): Repository<UserEntity> {
    return this.userRepository;
  }

  public async changeUserModeratedMode(id: number, canBeModeratePosts: boolean): Promise<void> {
    await this.userRepository.update({ id }, { canBeModeratePosts });
  }

  public findById(id: number): Promise<UserEntity | undefined> {
    return this.userRepository.findOne({ where: { id } });
  }

  public getModerators(): Promise<UserEntity[]> {
    return this.userRepository.find({ where: { isModerator: true, isBanned: false } });
  }

  public updateUserLastActivity(ctx: BotContext): Promise<InsertResult> {
    return this.userRepository.upsert(
      {
        id: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        isBot: ctx.from.is_bot,
        lastActivity: new Date(),
      },
      ['id']
    );
  }

  public async disableMemeLimitForUser(userId: number, hours: number): Promise<void> {
    try {
      const untilDate = new Date();
      untilDate.setHours(untilDate.getHours() + hours);

      // Добавляем логирование для отладки
      Logger.log(`Disabling meme limit for user ${userId} until ${untilDate}`, UserService.name);

      const result = await this.userRepository.update(
        { id: userId },
        { memeLimitDisabledUntil: untilDate }
      );

      // Проверяем, была ли обновлена запись
      if (result.affected === 0) {
        Logger.warn(
          `No user found with id ${userId} when trying to disable meme limit`,
          UserService.name
        );
      } else {
        Logger.log(`Successfully disabled meme limit for user ${userId}`, UserService.name);
      }
    } catch (error) {
      Logger.error(
        `Failed to disable meme limit for user ${userId}: ${error.message}`,
        UserService.name
      );
      throw error;
    }
  }

  public async isMemeLimitDisabled(userId: number): Promise<boolean> {
    try {
      const user = await this.userRepository.findOneBy({ id: userId });

      if (!user) {
        Logger.warn(
          `User with id ${userId} not found when checking meme limit status`,
          UserService.name
        );
        return false;
      }

      const isDisabled = user?.memeLimitDisabledUntil
        ? user.memeLimitDisabledUntil > new Date()
        : false;

      Logger.log(
        `Meme limit for user ${userId} is ${isDisabled ? 'disabled' : 'enabled'} (until ${
          user.memeLimitDisabledUntil
        })`,
        UserService.name
      );

      return isDisabled;
    } catch (error) {
      Logger.error(`Error checking meme limit status for user ${userId}: ${error.message}`, UserService.name);
      return false;
    }
  }

  public getUsersForPostModerate(): Promise<Pick<UserEntity, 'id'>[]> {
    return this.userRepository.find({
      select: { id: true },
      where: { canBeModeratePosts: true, isBanned: false },
      order: { lastActivity: 'DESC' },
    });
  }

  public checkPermission(ctx: BotContext, permission: UserPermissionEnum): boolean {
    if (ctx.config.isOwner) {
      return true;
    }

    const user = ctx?.config?.user;

    if (!user?.isModerator) {
      if (ctx?.callbackQuery) {
        ctx.api.banChatMember(ctx.callbackQuery.message.chat.id, ctx.callbackQuery.from.id);
      }
      return false;
    }

    switch (permission) {
      case UserPermissionEnum.IS_BASE_MODERATOR:
        return user.isModerator;
      case UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL:
        return user.allowPublishToChannel;
      case UserPermissionEnum.ALLOW_DELETE_REJECTED_POST:
        return user.allowDeleteRejectedPost;
      case UserPermissionEnum.ALLOW_RESTORE_DISCARDED_POST:
        return user.allowRestoreDiscardedPost;
      case UserPermissionEnum.ALLOW_SET_STRIKE:
        return user.allowSetStrike;
      case UserPermissionEnum.ALLOW_MAKE_BAN:
        return user.allowMakeBan;
      default:
        if (ctx?.callbackQuery) {
          ctx.answerCallbackQuery('У тебя нет прав, чтобы нажимать эту кнопку');
        }
    }
  }
}
