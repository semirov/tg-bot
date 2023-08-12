import { Inject, Injectable } from '@nestjs/common';
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
    await this.publishedPostHashesEntity.insert({ hash, memeChannelMessageId });
  }

  public async getPostImageHash(photo: PhotoSize[]): Promise<string> {
    try {
      const files = photo || [];
      const minSizedFile = files.find((file) => file.height > 300 && file.height < 800);

      if (!photo.length) {
        return null;
      }

      const file = await this.bot.api.getFile(minSizedFile.file_id);
      const fileResponse = await firstValueFrom(
        this.httpService.get(
          `https://api.telegram.org/file/bot${this.baseConfigService.botToken}/${file.file_path}`,
          { responseType: 'arraybuffer' }
        )
      );
      return await imghash.hash(fileResponse.data, 16);
    } catch (e) {
      return null;
    }
  }
}
