import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelMemeEntity } from '../entities/channel-meme.entity';

/**
 * Чтение сохранённых мемов канала (для `MemesController`).
 *
 * Раньше жило в `ChannelMonitorBotService` — монитор-бот удалён: он требовал
 * отдельный Telegram-токен и при его невалидности ронял весь процесс.
 */
@Injectable()
export class ChannelMemeService {
  constructor(
    @InjectRepository(ChannelMemeEntity)
    private readonly channelMemeRepository: Repository<ChannelMemeEntity>
  ) {}

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
}
