import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { TelegrafException, TelegrafExecutionContext } from 'nestjs-telegraf';
import { Scenes } from 'telegraf';
import { environment } from '../../../../environments/environment';
import { BaseConfigService } from '../../../config/base-config.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private baseConfigService: BaseConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const ctx = TelegrafExecutionContext.create(context);
    const { from } = ctx.getContext<Scenes.SceneContext>();

    const isAdmin = this.baseConfigService.adminIds.includes(from.id);
    if (!isAdmin) {
      throw new TelegrafException('Тебе нельзя этим пользоваться, уходи 😡');
    }

    return true;
  }
}
