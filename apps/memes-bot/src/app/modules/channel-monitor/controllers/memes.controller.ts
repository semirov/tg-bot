import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Controller, Get, Logger, NotFoundException, Res, StreamableFile } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Readable } from 'stream';
import { BaseConfigService } from '../../config/base-config.service';
import { ChannelMemeService } from '../services/channel-meme.service';

@Controller('memes')
@Throttle({ default: { limit: 10, ttl: 60000 } })
export class MemesController {
  private readonly logger = new Logger(MemesController.name);
  private readonly s3Client: S3Client;

  constructor(
    private channelMemeService: ChannelMemeService,
    private configService: BaseConfigService
  ) {
    this.s3Client = new S3Client({
      endpoint: this.configService.s3Endpoint,
      region: this.configService.s3Region,
      credentials: {
        accessKeyId: this.configService.s3AccessKeyId,
        secretAccessKey: this.configService.s3SecretAccessKey,
      },
    });
  }

  @Get('main/last')
  async getLastMainMeme(@Res({ passthrough: true }) res: Response) {
    this.logger.log('GET /memes/main/last');

    const meme = await this.channelMemeService.getLastMeme();

    if (!meme) {
      return this.returnPlaceholder(res);
    }

    return this.streamImageFromS3(meme.s3Key, res, meme.id.toString());
  }

  @Get('main/random')
  async getRandomMainMeme(@Res({ passthrough: true }) res: Response) {
    this.logger.log('GET /memes/main/random');

    const meme = await this.channelMemeService.getRandomMemeByType('main');

    if (!meme) {
      return this.returnPlaceholder(res);
    }

    return this.streamImageFromS3(meme.s3Key, res, meme.id.toString());
  }

  @Get('best/last')
  async getLastBestMeme(@Res({ passthrough: true }) res: Response) {
    this.logger.log('GET /memes/best/last');

    let meme = await this.channelMemeService.getLastBestMeme();

    // Fallback на основной канал
    if (!meme) {
      this.logger.log('No best meme found, falling back to main channel');
      meme = await this.channelMemeService.getLastMeme();
    }

    if (!meme) {
      return this.returnPlaceholder(res);
    }

    return this.streamImageFromS3(meme.s3Key, res, meme.id.toString());
  }

  @Get('best/random')
  async getRandomBestMeme(@Res({ passthrough: true }) res: Response) {
    this.logger.log('GET /memes/best/random');

    let meme = await this.channelMemeService.getRandomMemeByType('best');

    // Fallback на основной канал
    if (!meme) {
      this.logger.log('No best meme found, falling back to main channel');
      meme = await this.channelMemeService.getRandomMemeByType('main');
    }

    if (!meme) {
      return this.returnPlaceholder(res);
    }

    return this.streamImageFromS3(meme.s3Key, res, meme.id.toString());
  }

  private async streamImageFromS3(
    s3Key: string,
    res: Response,
    etag: string
  ): Promise<StreamableFile> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.configService.s3Bucket,
        Key: s3Key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new NotFoundException('Image not found in S3');
      }

      res.set({
        'Content-Type': response.ContentType || 'image/jpeg',
        'Content-Length': response.ContentLength,
        'Cache-Control': 'public, max-age=3600, must-revalidate',
        ETag: `"${etag}"`,
        'Last-Modified': response.LastModified?.toUTCString() || new Date().toUTCString(),
      });

      const stream = response.Body as Readable;
      return new StreamableFile(stream);
    } catch (error) {
      this.logger.error(`Failed to stream image from S3: ${s3Key}`, error);
      throw new NotFoundException('Failed to load image');
    }
  }

  private returnPlaceholder(res: Response): StreamableFile {
    this.logger.log('Returning placeholder image');

    // Создаем простое SVG изображение как placeholder
    const svg = `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="600" fill="#f0f0f0"/>
      <text x="400" y="300" font-family="Arial" font-size="24" fill="#666" text-anchor="middle">
        No memes available yet
      </text>
    </svg>`;

    const buffer = Buffer.from(svg, 'utf-8');

    res.set({
      'Content-Type': 'image/svg+xml',
      'Content-Length': buffer.length,
      'Cache-Control': 'no-cache',
    });

    return new StreamableFile(buffer);
  }
}
