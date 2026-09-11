import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotModule } from '../bot/bot.module';
import { AppConfigModule } from '../config/app-config.module';
import { TrollChatEntity } from './entities/troll-chat.entity';
import { DeepSeekService } from './services/deepseek.service';
import { TrollService } from './services/troll.service';

@Module({
  imports: [AppConfigModule, BotModule, TypeOrmModule.forFeature([TrollChatEntity])],
  providers: [TrollService, DeepSeekService],
  exports: [TrollService],
})
export class TrollModule {}
