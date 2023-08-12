import { Module } from '@nestjs/common';
import { ClientBaseService } from './services/client-base.service';
import { BotModule } from '../bot/bot.module';
import { AppConfigModule } from '../config/app-config.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientSessionEntity } from './entities/client-session.entity';

@Module({
  imports: [BotModule, AppConfigModule, TypeOrmModule.forFeature([ClientSessionEntity])],
  providers: [ClientBaseService],
  exports: [ClientBaseService],
})
export class ClientModule {}
