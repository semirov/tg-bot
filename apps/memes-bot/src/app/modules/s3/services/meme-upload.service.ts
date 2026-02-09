import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'grammy';
import { firstValueFrom } from 'rxjs';
import { BaseConfigService } from '../../config/base-config.service';
import { S3Service } from './s3.service';

@Injectable()
export class MemeUploadService {
  private readonly logger = new Logger(MemeUploadService.name);
  private bestMemesBuffer: Buffer[] = [];
  private bestMemesTimer: NodeJS.Timeout | null = null;

  constructor(
    private s3Service: S3Service,
    private configService: BaseConfigService,
    private httpService: HttpService
  ) {}

  /**
   * Обрабатывает новое сообщение из канала и загружает изображение в S3
   */
  async handleChannelPost(ctx: Context): Promise<void> {
    try {
      const message = ctx.channelPost || ctx.message;
      if (!message) {
        return;
      }

      const chatId = message.chat.id;
      const photo = message.photo;

      if (!photo || photo.length === 0) {
        return;
      }

      // Получаем самое большое изображение
      const largestPhoto = photo[photo.length - 1];
      const fileId = largestPhoto.file_id;

      // Получаем файл через API Telegram
      const file = await ctx.api.getFile(fileId);
      if (!file || !file.file_path) {
        this.logger.warn(`Cannot get file path for file_id: ${fileId}`);
        return;
      }

      // Формируем URL в зависимости от окружения
      let fileUrl: string;
      if (this.configService.tgEnv === 'test') {
        fileUrl = `https://api.telegram.org/file/bot${this.configService.botToken}/test/${file.file_path}`;
      } else {
        fileUrl = `https://api.telegram.org/file/bot${this.configService.botToken}/${file.file_path}`;
      }

      // Скачиваем файл
      const fileResponse = await firstValueFrom(
        this.httpService.get(fileUrl, { responseType: 'arraybuffer' })
      );
      const fileBuffer = Buffer.from(fileResponse.data);

      // Определяем тип канала и загружаем соответствующим образом
      if (chatId === this.configService.memeChanelId) {
        // Основной канал - загружаем как последний мем
        await this.s3Service.uploadLastMemeFromBuffer(fileBuffer);
        this.logger.log(`Uploaded last meme from main channel`);
      } else if (chatId === this.configService.bestMemeChanelId) {
        // Канал с лучшими мемами - буферизуем и загружаем через минуту
        this.bufferBestMeme(fileBuffer);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to handle channel post: ${errorMessage}`);
    }
  }

  /**
   * Буферизует лучшие мемы и загружает их через минуту
   */
  private bufferBestMeme(fileBuffer: Buffer): void {
    this.bestMemesBuffer.push(fileBuffer);
    this.logger.log(`Buffered best meme (${this.bestMemesBuffer.length} total)`);

    // Сбрасываем предыдущий таймер
    if (this.bestMemesTimer) {
      clearTimeout(this.bestMemesTimer);
    }

    // Устанавливаем новый таймер на 60 секунд
    this.bestMemesTimer = setTimeout(async () => {
      await this.uploadBufferedBestMemes();
    }, 60000);
  }

  /**
   * Загружает буферизованные лучшие мемы в S3
   */
  private async uploadBufferedBestMemes(): Promise<void> {
    if (this.bestMemesBuffer.length === 0) {
      return;
    }

    try {
      // Берем максимум 2 мема
      const memesToUpload = this.bestMemesBuffer.slice(0, 2);
      await this.s3Service.uploadBestMemesFromBuffers(memesToUpload);
      this.logger.log(`Uploaded ${memesToUpload.length} best meme(s) to S3`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to upload buffered best memes: ${errorMessage}`);
    } finally {
      // Очищаем буфер и таймер
      this.bestMemesBuffer = [];
      this.bestMemesTimer = null;
    }
  }

  /**
   * Принудительно обновляет мемы из каналов
   */
  async forceUpdateMemes(): Promise<void> {
    this.logger.log('Force updating memes from channels...');
    // Эта функция может быть вызвана вручную для обновления мемов
    // Реализация зависит от того, как вы хотите получать последние посты
  }
}
