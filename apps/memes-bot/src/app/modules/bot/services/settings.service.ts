import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Bot } from 'grammy';
import { IsNull, Not, Repository } from 'typeorm';
import { BaseConfigService } from '../../config/base-config.service';
import { SettingsEntity } from '../entities/settings.entity';
import { BotContext } from '../interfaces/bot-context.interface';
import { BOT } from '../providers/bot.provider';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(SettingsEntity)
    private settingsRepository: Repository<SettingsEntity>,
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService
  ) {}

  private async channelSettings(): Promise<SettingsEntity> {
    return this.settingsRepository.findOne({
      where: { joinLink: Not(IsNull()) },
      order: { id: 'DESC' },
    });
  }

  public async channelLinkUrl(): Promise<string> {
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.memeChanelId);
    const channelLink = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}`
      : channelInfo['invite_link'];
    const channelSettings = await this.channelSettings();
    return channelSettings?.joinLink || channelLink;
  }

  public async channelBestLinkUrl(): Promise<string> {
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.bestMemeChanelId);
    const channelLink = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}`
      : channelInfo['invite_link'];
    const channelSettings = await this.channelSettings();
    return channelSettings?.joinLink || channelLink;
  }

  public async channelBestChannelName(): Promise<string> {
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.bestMemeChanelId);
    return channelInfo.title || channelInfo['username'] || 'Лучшие мемы за сутки';
  }

  public async cringeChannelHtmlLink(): Promise<string> {
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.cringeMemeChannelId);
    const channelLink = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}`
      : channelInfo['invite_link'];

    return `<a href="${channelLink}">${channelInfo['title']}</a>`;
  }

  public async channelHtmlLinkIfPrivate(): Promise<string> {
    const channelSettings = await this.channelSettings();

    if (channelSettings?.joinLink && channelSettings?.postLinkText) {
      return `<a href="${channelSettings?.joinLink}">${channelSettings?.postLinkText}</a>`;
    }

    return '';
  }

  public async channelHtmlLink(): Promise<string> {
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.memeChanelId);
    const channelSettings = await this.channelSettings();
    const channelLink = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}`
      : channelInfo['invite_link'];

    return `<a href="${channelSettings?.joinLink || channelLink}">${
      channelSettings?.postLinkText || channelInfo['title']
    }</a>`;
  }
}
