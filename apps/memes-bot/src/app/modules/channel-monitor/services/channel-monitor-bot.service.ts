import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Bot, Context } from 'grammy';
import { Repository } from 'typeorm';
import { BaseConfigService } from '../../config/base-config.service';
import { S3Service } from '../../s3/services/s3.service';
import { ChannelMemeEntity } from '../entities/channel-meme.entity';

@Injectable()
export class ChannelMonitorBotService implements OnModuleInit {
  private readonly logger = new Logger(ChannelMonitorBotService.name);
  private bot!: Bot;
  private mainChannelId!: string;
  private bestChannelId!: string;

  constructor(
    @InjectRepository(ChannelMemeEntity)
    private channelMemeRepository: Repository<ChannelMemeEntity>,
    private configService: BaseConfigService,
    private s3Service: S3Service
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing Channel Monitor Bot...');
    await this.initializeBot();
    await this.startBot();
  }

  private async initializeBot() {
    try {
      const botToken = this.configService.monitorBotToken;
      this.mainChannelId = this.configService.monitorMainChannel;
      this.bestChannelId = this.configService.monitorBestChannel;

      this.bot = new Bot(botToken, { client: { environment: this.configService.tgEnv } });

      // Обработчик для постов из основного канала
      this.bot.on('channel_post:photo', async (ctx) => {
        await this.handleChannelPost(ctx, 'main');
      });

      this.logger.log('Channel Monitor Bot initialized successfully');
      this.logger.log(`Monitoring channels: ${this.mainChannelId}, ${this.bestChannelId}`);
    } catch (error) {
      this.logger.error('Failed to initialize bot:', error);
      throw error;
    }
  }

  private async startBot() {
    try {
      this.bot.start({
        onStart: () => {
          this.logger.log('Channel Monitor Bot started successfully');
        },
      });
    } catch (error) {
      this.logger.error('Failed to start bot:', error);
      throw error;
    }
  }

  private async handleChannelPost(ctx: Context, channelType: 'main' | 'best') {
    try {
      const message = ctx.channelPost;

      if (!message || !message.photo) {
        return;
      }

      const chatId = message.chat.id.toString();

      // Проверяем, что сообщение из нужного канала
      if (channelType === 'main' && chatId !== this.mainChannelId) {
        return;
      }

      if (channelType === 'best' && chatId !== this.bestChannelId) {
        return;
      }

      this.logger.log(
        `New photo in ${channelType} channel: ${message.message_id} from chat ${chatId}`
      );

      // Получаем файл с максимальным разрешением
      const photo = message.photo[message.photo.length - 1];
      const file = await ctx.api.getFile(photo.file_id);

      // Формируем URL в зависимости от окружения
      let fileUrl: string;
      if (this.configService.tgEnv === 'test') {
        fileUrl = `https://api.telegram.org/file/bot${this.configService.monitorBotToken}/test/${file.file_path}`;
      } else {
        fileUrl = `https://api.telegram.org/file/bot${this.configService.monitorBotToken}/${file.file_path}`;
      }

      this.logger.log(
        `Downloading file from: ${fileUrl.replace(this.configService.monitorBotToken, '***')}`
      );
      const buffer = await this.downloadFile(fileUrl);

      // Генерируем ключ для S3
      const timestamp = Date.now();
      const s3Key = `channel-memes/${channelType}/${timestamp}-${message.message_id}.jpg`;

      // Загружаем в S3
      await this.uploadToS3(buffer, s3Key);

      // Сохраняем в базу данных
      const meme = this.channelMemeRepository.create({
        channelId: chatId,
        channelType,
        messageId: message.message_id,
        s3Key,
        caption: message.caption || undefined,
        fileId: photo.file_id,
        fileSize: photo.file_size || buffer.length,
      });

      await this.channelMemeRepository.save(meme);

      // Обновляем last-meme или best-meme в зависимости от канала
      if (channelType === 'main') {
        await this.s3Service.uploadLastMemeFromBuffer(buffer);
        this.logger.log('Updated last-meme in S3');
      } else {
        await this.s3Service.uploadBestMemesFromBuffers([buffer]);
        this.logger.log('Updated best-meme in S3');
      }

      this.logger.log(
        `Successfully processed meme from ${channelType} channel: ${message.message_id}`
      );
    } catch (error) {
      this.logger.error('Error handling channel post:', error);
    }
  }

  private async downloadFile(url: string): Promise<Buffer> {
    const https = await import('https');

    return new Promise((resolve, reject) => {
      https
        .get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download file: ${response.statusCode}`));
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

  private async uploadToS3(buffer: Buffer, key: string): Promise<void> {
    try {
      const { PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');

      const s3Client = new S3Client({
        endpoint: this.configService.s3Endpoint,
        region: this.configService.s3Region,
        credentials: {
          accessKeyId: this.configService.s3AccessKeyId,
          secretAccessKey: this.configService.s3SecretAccessKey,
        },
      });

      const command = new PutObjectCommand({
        Bucket: this.configService.s3Bucket,
        Key: key,
        Body: buffer,
        ContentType: 'image/jpeg',
      });

      await s3Client.send(command);
      this.logger.log(`Uploaded to S3: ${key}`);
    } catch (error) {
      this.logger.error('Failed to upload to S3:', error);
      throw error;
    }
  }

  async getLastMeme(): Promise<ChannelMemeEntity | null> {
    return this.channelMemeRepository.findOne({
      where: { channelType: 'main' },
      order: { createdAt: 'DESC' },
    });
  }

  async getLastBestMeme(): Promise<ChannelMemeEntity | null> {
    return this.channelMemeRepository.findOne({
      where: { channelType: 'best' },
      order: { createdAt: 'DESC' },
    });
  }

  async getRandomMeme(): Promise<ChannelMemeEntity | null> {
    const count = await this.channelMemeRepository.count();

    if (count === 0) {
      return null;
    }

    const randomIndex = Math.floor(Math.random() * count);

    const memes = await this.channelMemeRepository.find({
      skip: randomIndex,
      take: 1,
    });

    return memes[0] || null;
  }

  async getRandomMemeByType(channelType: 'main' | 'best'): Promise<ChannelMemeEntity | null> {
    const count = await this.channelMemeRepository.count({
      where: { channelType },
    });

    if (count === 0) {
      return null;
    }

    const randomIndex = Math.floor(Math.random() * count);

    const memes = await this.channelMemeRepository.find({
      where: { channelType },
      skip: randomIndex,
      take: 1,
    });

    return memes[0] || null;
  }

  async getBestMemes(limit = 10): Promise<ChannelMemeEntity[]> {
    return this.channelMemeRepository.find({
      where: { channelType: 'best' },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getAllMemes(limit = 50): Promise<ChannelMemeEntity[]> {
    return this.channelMemeRepository.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
