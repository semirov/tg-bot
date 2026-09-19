import { Module } from '@nestjs/common';
import { ObservatoryService } from './services/observatory.service';
import { BotModule } from '../bot/bot.module';
import { AppConfigModule } from '../config/app-config.module';
import { MattermostModule } from '../mattermost/mattermost.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ObservatoryPostEntity } from './entities/observatory-post.entity';
import { UserModeratedPostEntity } from './entities/user-moderated-post.entity';
import { UserModeratedPostService } from './services/user-moderated-post.service';
import { UserMessageModeratedPostEntity } from './entities/user-message-moderated-post.entity';
import { TrollModule } from '../troll/troll.module';

@Module({
  imports: [
    BotModule,
    AppConfigModule,
    MattermostModule,
    TrollModule,
    TypeOrmModule.forFeature([
      ObservatoryPostEntity,
      UserModeratedPostEntity,
      UserMessageModeratedPostEntity,
    ]),
  ],
  providers: [ObservatoryService, UserModeratedPostService],
  exports: [ObservatoryService],
})
export class ObservatoryModule {}
