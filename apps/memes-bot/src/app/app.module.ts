import { Module } from '@nestjs/common';

import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppService } from './app.service';
import { BotModule } from './modules/bot/bot.module';
import { CringePostEntity } from './modules/bot/entities/cringe-post.entity';
import { PostSchedulerEntity } from './modules/bot/entities/post-scheduler.entity';
import { PublishedPostHashesEntity } from './modules/bot/entities/published-post-hashes.entity';
import { SettingsEntity } from './modules/bot/entities/settings.entity';
import { UserRequestEntity } from './modules/bot/entities/user-request.entity';
import { UserEntity } from './modules/bot/entities/user.entity';
import { SessionEntity } from './modules/bot/session/session.entity';
import { ChannelMonitorModule } from './modules/channel-monitor/channel-monitor.module';
import { ChannelMemeEntity } from './modules/channel-monitor/entities/channel-meme.entity';
import { ClientModule } from './modules/client/client.module';
import { ClientSessionEntity } from './modules/client/entities/client-session.entity';
import { BestMemePostEntity } from './modules/client/entities/best-meme-post.entity';
import { AppConfigModule } from './modules/config/app-config.module';
import { BaseConfigService } from './modules/config/base-config.service';
import { CronModule } from './modules/cron/cron.module';
import { MenuModule } from './modules/menus/menu.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { ObservatoryPostEntity } from './modules/observatory/entities/observatory-post.entity';
import { UserMessageModeratedPostEntity } from './modules/observatory/entities/user-message-moderated-post.entity';
import { UserModeratedPostEntity } from './modules/observatory/entities/user-moderated-post.entity';
import { ObservatoryModule } from './modules/observatory/observatory.module';
import { PostManagementModule } from './modules/post-management/post-management.module';
import { YearResultEntity } from './modules/year-results/entities/year-result.entity';
import { YearResultsModule } from './modules/year-results/year-results.module';
import { MattermostModule } from './modules/mattermost/mattermost.module';
import { TrollChatEntity } from './modules/troll/entities/troll-chat.entity';
import { TrollDefectEntity } from './modules/troll/entities/troll-defect.entity';
import { ParserModule } from './modules/parser/parser.module';
import { ObservedPostEntity } from './modules/parser/entities/observed-post.entity';
import { ParserSettingsEntity } from './modules/parser/entities/parser-settings.entity';
import { SourceCandidateEntity } from './modules/parser/entities/source-candidate.entity';
import { SourceChannelEntity } from './modules/parser/entities/source-channel.entity';
import { TrollMessageEntity } from './modules/troll/entities/troll-message.entity';
import { TrollPredictionEntity } from './modules/troll/entities/troll-prediction.entity';
import { TrollSettingsEntity } from './modules/troll/entities/troll-settings.entity';
import { TrollModule } from './modules/troll/troll.module';
import { SharedModule } from './shared/shared.module';

@Module({
  imports: [
    AppConfigModule,
    SharedModule,
    BotModule,
    ObservatoryModule,
    ChannelMonitorModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 60 секунд
        limit: 10, // 10 запросов
      },
    ]),
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      useFactory: (configService: BaseConfigService) => ({
        type: 'postgres',
        host: configService.databaseHost,
        port: configService.databasePort,
        username: configService.databaseUsername,
        password: configService.databasePassword,
        database: configService.databaseName,
        entities: [
          SessionEntity,
          UserRequestEntity,
          UserEntity,
          ClientSessionEntity,
          BestMemePostEntity,
          ObservatoryPostEntity,
          PostSchedulerEntity,
          SettingsEntity,
          CringePostEntity,
          PublishedPostHashesEntity,
          UserModeratedPostEntity,
          UserMessageModeratedPostEntity,
          YearResultEntity,
          ChannelMemeEntity,
          TrollChatEntity,
          TrollSettingsEntity,
          TrollMessageEntity,
          TrollPredictionEntity,
          TrollDefectEntity,
          SourceChannelEntity,
          ObservedPostEntity,
          SourceCandidateEntity,
          ParserSettingsEntity,
        ],
        synchronize: true,
        extra: configService.useSSL
          ? {
              ssl: {
                rejectUnauthorized: false,
              },
            }
          : undefined,
      }),
      inject: [BaseConfigService],
    }),
    PostManagementModule,
    MenuModule,
    ClientModule,
    CronModule,
    YearResultsModule,
    MattermostModule,
    TrollModule,
    ParserModule,
    MetricsModule,
  ],
  controllers: [],
  providers: [AppService],
})
export class AppModule {}
