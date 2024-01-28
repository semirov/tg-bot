import {Injectable} from '@nestjs/common';
import {BaseConfigService} from '../../config/base-config.service';

import {Middleware, NextFunction} from 'grammy/out/composer';
import {BotContext} from '../interfaces/bot-context.interface';

@Injectable()
export class BotConfigMiddleware {
  constructor(private baseConfigService: BaseConfigService) {
  }

  public configMiddleware(): Middleware {
    return async (ctx: BotContext, next: NextFunction) => {
      ctx.config = {
        isOwner: ctx?.from?.id === this.baseConfigService.ownerId,
      };
      await next();
    };
  }
}
