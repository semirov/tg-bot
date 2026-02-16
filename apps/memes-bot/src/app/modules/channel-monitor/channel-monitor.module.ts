import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from '../config/app-config.module';
import { S3Module } from '../s3/s3.module';
import { MemesController } from './controllers/memes.controller';
import { ChannelMemeEntity } from './entities/channel-meme.entity';
import { ChannelMonitorBotService } from './services/channel-monitor-bot.service';

@Module({
  imports: [AppConfigModule, S3Module, TypeOrmModule.forFeature([ChannelMemeEntity])],
  controllers: [MemesController],
  providers: [ChannelMonitorBotService],
  exports: [ChannelMonitorBotService],
})
export class ChannelMonitorModule {}
