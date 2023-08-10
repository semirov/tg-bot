import {Module} from '@nestjs/common';
import {ObservatoryService} from './services/observatory.service';
import {BotModule} from '../bot/bot.module';
import {AppConfigModule} from '../config/app-config.module';
import {ClientModule} from '../client/client.module';
import {TypeOrmModule} from '@nestjs/typeorm';
import {ObservatoryPostEntity} from './entities/observatory-post.entity';
import {UserModeratedPostEntity} from './entities/user-moderated-post.entity';
import {UserModeratedPostService} from './services/user-moderated-post.service';
import {UserMessageModeratedPostEntity} from './entities/user-message-moderated-post.entity';

@Module({
  imports: [
    BotModule,
    AppConfigModule,
    ClientModule,
    TypeOrmModule.forFeature([
      ObservatoryPostEntity,
      UserModeratedPostEntity,
      UserMessageModeratedPostEntity,
    ]),
  ],
  providers: [ObservatoryService, UserModeratedPostService],
  exports: [ObservatoryService],
})
export class ObservatoryModule {
}
