import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import * as http from 'http';
import * as https from 'https';
import { BaseConfigService } from '../../config/base-config.service';

export enum MemeType {
  LAST_MEME = 'last-meme',
  BEST_MEME = 'best-meme',
}

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;

  constructor(private configService: BaseConfigService) {
    this.bucket = this.configService.s3Bucket;

    this.s3Client = new S3Client({
      endpoint: this.configService.s3Endpoint,
      region: this.configService.s3Region,
      credentials: {
        accessKeyId: this.configService.s3AccessKeyId,
        secretAccessKey: this.configService.s3SecretAccessKey,
      },
    });
  }

  /**
   * Загружает изображение в S3 бакет
   * @param imageUrl URL изображения для загрузки
   * @param type Тип мема (последний или лучший)
   * @param position Позиция для лучших мемов (first или second)
   */
  async uploadImage(
    imageUrl: string,
    type: MemeType,
    position?: 'first' | 'second'
  ): Promise<void> {
    try {
      // Скачиваем изображение
      const imageBuffer = await this.downloadImage(imageUrl);

      // Определяем путь в зависимости от типа
      let key: string;
      if (type === MemeType.LAST_MEME) {
        key = 'last-meme/meme.img';
      } else {
        if (!position) {
          throw new Error('Position is required for best memes');
        }
        key = `best-meme/${position}.img`;
      }

      // Загружаем в S3
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: imageBuffer,
        ContentType: this.getContentType(imageUrl),
      });

      await this.s3Client.send(command);
      this.logger.log(`Successfully uploaded image to ${key}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to upload image: ${errorMessage}`, errorStack);
      throw error;
    }
  }

  /**
   * Загружает последний мем из основного канала
   */
  async uploadLastMeme(imageUrl: string): Promise<void> {
    await this.uploadImage(imageUrl, MemeType.LAST_MEME);
  }

  /**
   * Загружает последний мем из Buffer
   */
  async uploadLastMemeFromBuffer(imageBuffer: Buffer): Promise<void> {
    try {
      const key = 'last-meme/meme.img';
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: imageBuffer,
        ContentType: 'image/jpeg',
      });

      await this.s3Client.send(command);
      this.logger.log(`Successfully uploaded image to ${key}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to upload image: ${errorMessage}`, errorStack);
      throw error;
    }
  }

  /**
   * Загружает лучшие мемы (один или два)
   * @param imageUrls Массив URL изображений (1 или 2 элемента)
   */
  async uploadBestMemes(imageUrls: string[]): Promise<void> {
    if (imageUrls.length === 0 || imageUrls.length > 2) {
      throw new Error('Best memes array must contain 1 or 2 images');
    }

    // Загружаем первый мем
    await this.uploadImage(imageUrls[0], MemeType.BEST_MEME, 'first');

    // Если есть второй мем, загружаем его
    if (imageUrls.length === 2) {
      await this.uploadImage(imageUrls[1], MemeType.BEST_MEME, 'second');
    }
  }

  /**
   * Загружает лучшие мемы из Buffer
   */
  async uploadBestMemesFromBuffers(imageBuffers: Buffer[]): Promise<void> {
    if (imageBuffers.length === 0 || imageBuffers.length > 2) {
      throw new Error('Best memes array must contain 1 or 2 images');
    }

    try {
      // Загружаем первый мем
      const firstCommand = new PutObjectCommand({
        Bucket: this.bucket,
        Key: 'best-meme/first.img',
        Body: imageBuffers[0],
        ContentType: 'image/jpeg',
      });
      await this.s3Client.send(firstCommand);
      this.logger.log(`Successfully uploaded image to best-meme/first.img`);

      // Если есть второй мем, загружаем его
      if (imageBuffers.length === 2) {
        const secondCommand = new PutObjectCommand({
          Bucket: this.bucket,
          Key: 'best-meme/second.img',
          Body: imageBuffers[1],
          ContentType: 'image/jpeg',
        });
        await this.s3Client.send(secondCommand);
        this.logger.log(`Successfully uploaded image to best-meme/second.img`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to upload images: ${errorMessage}`, errorStack);
      throw error;
    }
  }

  /**
   * Скачивает изображение по URL
   */
  private async downloadImage(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      protocol
        .get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download image: ${response.statusCode}`));
            return;
          }

          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve(Buffer.concat(chunks as any)));
          response.on('error', reject);
        })
        .on('error', reject);
    });
  }

  /**
   * Определяет Content-Type по URL изображения
   */
  private getContentType(url: string): string {
    const extension = url.split('.').pop()?.toLowerCase();

    switch (extension) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      default:
        return 'application/octet-stream';
    }
  }
}
