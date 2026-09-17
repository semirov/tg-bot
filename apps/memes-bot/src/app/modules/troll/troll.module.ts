import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotModule } from '../bot/bot.module';
import { ChannelMemeEntity } from '../channel-monitor/entities/channel-meme.entity';
import { AppConfigModule } from '../config/app-config.module';
import { TrollChatEntity } from './entities/troll-chat.entity';
import { TrollDefectEntity } from './entities/troll-defect.entity';
import { TrollMessageEntity } from './entities/troll-message.entity';
import { TrollPredictionEntity } from './entities/troll-prediction.entity';
import { TrollSettingsEntity } from './entities/troll-settings.entity';
import { DeepSeekService } from './services/deepseek.service';
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
      ChannelMemeEntity,
    ]),
  ],
  providers: [TrollService, TrollSettingsService, DeepSeekService],
  exports: [TrollService, TrollSettingsService, DeepSeekService],
})
export class TrollModule {}
