import { Injectable } from '@nestjs/common';
import { BotContext } from '../interfaces/bot-context.interface';
import { InjectRepository } from '@nestjs/typeorm';
import { UserEntity } from '../entities/user.entity';
import { InsertResult, Repository } from 'typeorm';
import { UserPermissionEnum } from '../constants/user-permission.enum';

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
        return false;
    }
  }
}
