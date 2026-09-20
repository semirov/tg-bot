import { Module } from '@nestjs/common';
import { ClientBaseService } from './services/client-base.service';
import { BotModule } from '../bot/bot.module';
import { AppConfigModule } from '../config/app-config.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientSessionEntity } from './entities/client-session.entity';
import { BestMemePostEntity } from './entities/best-meme-post.entity';

@Module({
  imports: [BotModule, AppConfigModule, TypeOrmModule.forFeature([ClientSessionEntity, BestMemePostEntity])],
  providers: [ClientBaseService],
  exports: [ClientBaseService],
})
export class ClientModule {}
