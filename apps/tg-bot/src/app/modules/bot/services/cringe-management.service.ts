import {Inject, Injectable} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {IsNull, Not, Repository} from 'typeorm';
import {CringePostEntity} from '../entities/cringe-post.entity';
import {BOT} from '../providers/bot.provider';
import {Bot} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {BaseConfigService} from '../../config/base-config.service';

@Injectable()
export class CringeManagementService {
  constructor(
    private baseConfigService: BaseConfigService,
    @Inject(BOT) private bot: Bot<BotContext>,
    @InjectRepository(CringePostEntity)
    private cringePostEntity: Repository<CringePostEntity>
  ) {
  }

  public get repository(): Repository<CringePostEntity> {
    return this.cringePostEntity;
  }

  async moveCringeMessages() {
    const cringePosts = await this.repository.find({
      where: {
        isMovedToCringe: false,
        memeChannelMessageId: Not(IsNull())
      }
    });

    if (!cringePosts?.length) {
      return;
    }

    for (const cringePost of cringePosts) {
      const cringeMessage = await this.bot.api.copyMessage(
        this.baseConfigService.cringeMemeChannelId,
        this.baseConfigService.memeChanelId,
        cringePost.memeChannelMessageId, {disable_notification: true}
      );

      await this.repository.update(
        {memeChannelMessageId: cringePost.memeChannelMessageId},
        {isMovedToCringe: true, cringeChannelMessageId: cringeMessage.message_id}
      );

      await this.bot.api.deleteMessage(
        this.baseConfigService.memeChanelId,
        cringePost.memeChannelMessageId
      );
    }
  }
}
