import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'grammy';
import { NextFunction } from 'grammy/out/composer';
import { MemeUploadService } from '../services/meme-upload.service';

@Injectable()
export class ChannelPostMiddleware {
  private readonly logger = new Logger(ChannelPostMiddleware.name);

  constructor(private memeUploadService: MemeUploadService) {}

  middleware() {
    return async (ctx: Context, next: NextFunction) => {
      // Логируем все события для отладки
      if (ctx.channelPost) {
        this.logger.log(
          `Channel post received from chat ${ctx.channelPost.chat.id}, has photo: ${!!ctx
            .channelPost.photo}`
        );
      }

      // Обрабатываем только посты из каналов с фото
      if (ctx.channelPost && ctx.channelPost.photo) {
        this.logger.log(`Processing channel post from chat ${ctx.channelPost.chat.id}`);
        await this.memeUploadService.handleChannelPost(ctx);
      }

      await next();
    };
  }
}
