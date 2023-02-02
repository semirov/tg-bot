import {Injectable} from '@nestjs/common';
import {BaseConfigService} from '../../config/base-config.service';

import {Middleware, NextFunction} from 'grammy/out/composer';
import {BotContext} from '../interfaces/bot-context.interface';
import {UserService} from "../services/user.service";

@Injectable()
export class BotConfigMiddleware {
  constructor(private baseConfigService: BaseConfigService, private userService: UserService) {
  }

  public configMiddleware(): Middleware {
    const adminIds = this.baseConfigService.ownerId;

    return async (ctx: BotContext, next: NextFunction) => {
      const user = await this.userService.findById(ctx.from.id);
      ctx.config = {
        isOwner: adminIds.includes(ctx?.from?.id),
        user: user,
      };
      await next();
    };
  }

}
