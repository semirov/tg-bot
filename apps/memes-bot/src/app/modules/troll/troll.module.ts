import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotModule } from '../bot/bot.module';
import { ChannelMemeEntity } from '../channel-monitor/entities/channel-meme.entity';
import { AppConfigModule } from '../config/app-config.module';
import { TrollChatEntity } from './entities/troll-chat.entity';
import { TrollDefectEntity } from './entities/troll-defect.entity';
import { TrollMemberBioEntity } from './entities/troll-member-bio.entity';
import { TrollMessageEntity } from './entities/troll-message.entity';
import { TrollMemberTagEntity } from './entities/troll-member-tag.entity';
import { TrollPredictionEntity } from './entities/troll-prediction.entity';
import { TrollSettingsEntity } from './entities/troll-settings.entity';
import { DeepSeekService } from './services/deepseek.service';
import { TrollMemberBioService } from './services/troll-member-bio.service';
import { TrollMemberTagsService } from './services/troll-member-tags.service';
import { TrollSettingsService } from './services/troll-settings.service';
import { TrollService } from './services/troll.service';

@Module({
  imports: [
    AppConfigModule,
    BotModule,
    TypeOrmModule.forFeature([
      TrollChatEntity,
      TrollSettingsEntity,
      TrollMessageEntity,
      TrollPredictionEntity,
      TrollDefectEntity,
      TrollMemberTagEntity,
      TrollMemberBioEntity,
      ChannelMemeEntity,
    ]),
  ],
  providers: [
    TrollService,
    TrollSettingsService,
    DeepSeekService,
    TrollMemberTagsService,
    TrollMemberBioService,
  ],
  exports: [TrollService, TrollSettingsService, DeepSeekService],
})
export class TrollModule {}
