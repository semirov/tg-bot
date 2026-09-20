import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from '../config/app-config.module';
import { MemesController } from './controllers/memes.controller';
import { ChannelMemeEntity } from './entities/channel-meme.entity';
import { ChannelMemeService } from './services/channel-meme.service';

@Module({
  imports: [AppConfigModule, TypeOrmModule.forFeature([ChannelMemeEntity])],
  controllers: [MemesController],
  providers: [ChannelMemeService],
  exports: [ChannelMemeService],
})
export class ChannelMonitorModule {}
