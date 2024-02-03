import {Injectable, Logger} from '@nestjs/common';
import {BaseConfigService} from '../../config/base-config.service';

import {Middleware, NextFunction} from 'grammy/out/composer';
import {BotContext} from '../interfaces/bot-context.interface';
import {BotError, Context, GrammyError, HttpError, session} from 'grammy';
import {TypeormAdapter} from '@grammyjs/storage-typeorm';
import {sequentialize} from '@grammyjs/runner';
import {InjectRepository} from '@nestjs/typeorm';
import {SessionEntity} from '../entities/session.entity';
import {Repository} from 'typeorm';
import {UserEntity} from "../entities/user.entity";

@Injectable()
export class BotConfigMiddleware {
  constructor(
    private baseConfigService: BaseConfigService,
    @InjectRepository(SessionEntity)
    private sessionRepository: Repository<SessionEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {
  }


  public prepareSessionManager() {
    return session({
      initial: () => ({}),
      getSessionKey: this.sequentializeFn,
      storage: new TypeormAdapter({
        repository: this.sessionRepository,
      }),
    });
  }

  public prepareSequentialize() {
    return sequentialize(this.sequentializeFn);
  }

  private sequentializeFn = (ctx: Context) => {
    return [ctx?.chat?.id, ctx?.from?.id].filter(Boolean).join('_');
  };

  public prepareConfigMiddleware(): Middleware {
    return async (ctx: BotContext, next: NextFunction) => {
      if (!ctx?.from?.id) {
        next();
      }
      const user = await this.userRepository.upsert(
        {
          id: ctx.from.id,
          lastActivity: new Date(),
        },
        ['id']
      );

      const rawUser: Partial<UserEntity> = Array.isArray(user.raw) && user.raw[0];

      ctx.config = {
        isOwner: ctx?.from?.id === this.baseConfigService.ownerId,
        banned: rawUser.banned,
        captchaMode: rawUser.captcha,

      };
      if (ctx.config.banned) {
        return;
      }
      next();
    };
  }

  public prepareErrorHandler() {
    return (err: BotError<BotContext>) => {
      const ctx = err.ctx;
      const e = err.error;
      if (e instanceof GrammyError) {
        Logger.error(
          `Error in bot @${ctx.me.username} (id: ${ctx.me.id})`,
          e.description,
          BotConfigMiddleware.name
        );
      } else if (e instanceof HttpError) {
        Logger.error('Could not contact Telegram:', e, BotConfigMiddleware.name);
      } else {
        Logger.error('Unknown error: ', err, BotConfigMiddleware.name);
      }
    };
  }
}
