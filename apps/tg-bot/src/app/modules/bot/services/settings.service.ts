import {Inject, Injectable} from '@nestjs/common';
import {BotContext} from '../interfaces/bot-context.interface';
import {InjectRepository} from '@nestjs/typeorm';
import {IsNull, Not, Repository} from 'typeorm';
import {SettingsEntity} from '../entities/settings.entity';
import {BOT} from '../providers/bot.provider';
import {Bot} from 'grammy';
import {BaseConfigService} from '../../config/base-config.service';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(SettingsEntity)
    private settingsRepository: Repository<SettingsEntity>,
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService
  ) {
  }

  public async channelLinkUrl(): Promise<string> {
    const lastActiveLink = await this.settingsRepository.findOne({
      where: {joinLink: Not(IsNull())},
      order: {id: 'DESC'},
    });

    return lastActiveLink.joinLink;
  }

  public async channelHtmlLink(): Promise<string> {
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.memeChanelId);
    const channelLinkUrl = await this.channelLinkUrl();
    const channelLink = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}`
      : channelInfo['invite_link'];

    return `<a href="${channelLinkUrl || channelLink}">${channelInfo['title']}</a>`;
  }
}
