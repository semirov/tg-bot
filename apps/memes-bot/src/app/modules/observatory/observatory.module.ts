import { Module } from '@nestjs/common';
import { ObservatoryService } from './services/observatory.service';
import { BotModule } from '../bot/bot.module';
import { AppConfigModule } from '../config/app-config.module';
import { MattermostModule } from '../mattermost/mattermost.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ObservatoryPostEntity } from './entities/observatory-post.entity';
import { ParserModule } from '../parser/parser.module';

@Module({
  imports: [
    BotModule,
    AppConfigModule,
    MattermostModule,
    ParserModule,
    TypeOrmModule.forFeature([
      ObservatoryPostEntity,
    ]),
  ],
  providers: [ObservatoryService],
  exports: [ObservatoryService],
})
export class ObservatoryModule {}
