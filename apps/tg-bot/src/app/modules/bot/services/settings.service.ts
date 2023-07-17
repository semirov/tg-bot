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

  private async channelSettings(): Promise<SettingsEntity> {
    return this.settingsRepository.findOne({
      where: {joinLink: Not(IsNull())},
      order: {id: 'DESC'},
    });
  }

  public async channelLinkUrl(): Promise<string> {
    const channelSettings = await this.channelSettings();
    return channelSettings?.joinLink;
  }

  public async cringeChannelHtmlLink(): Promise<string> {
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.cringeMemeChannelId);
    const channelLink = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}`
      : channelInfo['invite_link'];

    return `<a href="${channelLink}">${channelInfo['title']}</a>`;
  }

  public async channelHtmlLinkIfPrivate(): Promise<string> {
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.memeChanelId);
    const channelSettings = await this.channelSettings();
    if (channelInfo && channelInfo['username']) {
      return '';
    }
    const channelLink = channelInfo['invite_link'];

    return `<a href="${channelSettings?.joinLink || channelLink}">${
      channelSettings?.postLinkText || channelInfo['title']
    }</a>`;
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
