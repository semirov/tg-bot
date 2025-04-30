import { Inject, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';

import { BaseConfigService } from '../../config/base-config.service';
import { firstValueFrom } from 'rxjs';
import * as imghash from 'imghash';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PublishedPostHashesEntity } from '../entities/published-post-hashes.entity';
import { PhotoSize } from 'grammy/out/types';
import { BOT } from '../providers/bot.provider';
import { Bot } from 'grammy';
import { BotContext } from '../interfaces/bot-context.interface';

@Injectable()
export class DeduplicationService {
  private readonly logger = new Logger(DeduplicationService.name);

  constructor(
    private httpService: HttpService,
    private baseConfigService: BaseConfigService,
    @InjectRepository(PublishedPostHashesEntity)
    private publishedPostHashesEntity: Repository<PublishedPostHashesEntity>,
    @Inject(BOT) private bot: Bot<BotContext>
  ) {}

  public async checkDuplicate(
    hash: string
  ): Promise<{ memePostId: number; distance: number; days: number }[]> {
    if (!hash) {
      return [];
    }
    const result = await this.publishedPostHashesEntity.query(
      `
        SELECT hash, "memeChannelMessageId", SIMILARITY(hash, $1) distance
        from published_post_hashes_entity
        where hash is not null
          and "createdAt" >= now() - INTERVAL '365 DAYS'
        ORDER BY distance DESC LIMIT 1
      `,
      [hash]
    );
    return result.map((res) => ({ memePostId: res.memeChannelMessageId, distance: res.distance }));
  }

  public async createPublishedPostHash(hash: string, memeChannelMessageId: number): Promise<void> {
    if (hash) {
      await this.publishedPostHashesEntity.insert({ hash, memeChannelMessageId });
    } else {
      this.logger.warn(`Cannot create hash for memeChannelMessageId ${memeChannelMessageId}`);
    }
  }

  /**
   * Вычисляет "расстояние" между двумя хешами
   * @param hash1 Первый хеш
   * @param hash2 Второй хеш
   * @returns Значение от 0 до 1, где 1 - полное совпадение
   */
  public calculateHashDistance(hash1: string, hash2: string): number {
    if (!hash1 || !hash2 || hash1.length !== hash2.length) {
      return 0;
    }

    // Вычисляем количество совпадающих бит
    let matchingBits = 0;
    for (let i = 0; i < hash1.length; i++) {
      if (hash1[i] === hash2[i]) {
        matchingBits++;
      }
    }

    // Возвращаем долю совпадающих бит
    return matchingBits / hash1.length;
  }

  public async getPostImageHash(photo: PhotoSize[]): Promise<string> {
    try {
      if (!photo || !photo.length) {
        this.logger.warn('No photo provided for hashing');
        return null;
      }

      // Выбираем подходящий размер фото
      const minSizedFile = photo.find((file) => file.height > 300 && file.height < 800) || photo[photo.length - 1];

      if (!minSizedFile) {
        this.logger.warn('Cannot find suitable photo size for hashing');
        return null;
      }

      // Получаем файл через API Telegram
      const file = await this.bot.api.getFile(minSizedFile.file_id);

      if (!file || !file.file_path) {
        this.logger.warn(`Cannot get file path for file_id: ${minSizedFile.file_id}`);
        return null;
      }

      // Формируем URL в зависимости от окружения
      let fileUrl: string;
      if (this.baseConfigService.tgEnv === 'test') {
        // URL для тестовой среды
        fileUrl = `https://api.telegram.org/file/bot${this.baseConfigService.botToken}/test/${file.file_path}`;
      } else {
        // URL для продакшн среды
        fileUrl = `https://api.telegram.org/file/bot${this.baseConfigService.botToken}/${file.file_path}`;
      }

      // Получаем содержимое файла
      try {
        const fileResponse = await firstValueFrom(
          this.httpService.get(fileUrl, { responseType: 'arraybuffer' })
        );

        // Вычисляем хеш изображения
        return await imghash.hash(fileResponse.data, 16);
      } catch (error) {
        this.logger.error(`Error fetching image file: ${error.message}`, error.stack);

        // Альтернативный способ получения файла, если первый способ не сработал
        try {
          if (this.baseConfigService.tgEnv === 'test') {
            // В тестовой среде используем другой URL или метод
            // Возможно, нужно использовать другие параметры или заголовки
            const alternativeUrl = `https://api.telegram.org/file/bot${this.baseConfigService.botToken}/${file.file_path}`;
            const alternativeResponse = await firstValueFrom(
              this.httpService.get(alternativeUrl, {
                responseType: 'arraybuffer',
                headers: {
                  'User-Agent': 'TelegramBot (like TwitterBot)'
                }
              })
            );
            return await imghash.hash(alternativeResponse.data, 16);
          } else {
            // В случае ошибки в продакшн возвращаем null
            return null;
          }
        } catch (alternativeError) {
          this.logger.error(`Alternative method also failed: ${alternativeError.message}`, alternativeError.stack);
          return null;
        }
      }
    } catch (e) {
      this.logger.error(`Error in getPostImageHash: ${e.message}`, e.stack);
      return null;
    }
  }

  // Синтетический метод хеширования для случаев, когда API не может получить файл
  // Используется только в тестовой среде как резервный вариант
  private generateSyntheticHash(fileId: string): string {
    // Генерируем псевдо-хеш на основе file_id
    // Это не настоящий perceptual hash, но может использоваться для тестирования
    const hash = Buffer.from(fileId).toString('hex').substring(0, 16);
    this.logger.warn(`Using synthetic hash for file_id: ${fileId}`);
    return hash;
  }
}
