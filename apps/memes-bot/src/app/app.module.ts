import { Module } from '@nestjs/common';

import { ScheduleModule } from '@nestjs/schedule';
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
import { ClientModule } from './modules/client/client.module';
import { ClientSessionEntity } from './modules/client/entities/client-session.entity';
import { AppConfigModule } from './modules/config/app-config.module';
import { BaseConfigService } from './modules/config/base-config.service';
import { CronModule } from './modules/cron/cron.module';
import { MenuModule } from './modules/menus/menu.module';
import { ObservatoryPostEntity } from './modules/observatory/entities/observatory-post.entity';
import { UserMessageModeratedPostEntity } from './modules/observatory/entities/user-message-moderated-post.entity';
import { UserModeratedPostEntity } from './modules/observatory/entities/user-moderated-post.entity';
import { ObservatoryModule } from './modules/observatory/observatory.module';
import { PostManagementModule } from './modules/post-management/post-management.module';
import { YearResultEntity } from './modules/year-results/entities/year-result.entity';
import { YearResultsModule } from './modules/year-results/year-results.module';

@Module({
  imports: [
    AppConfigModule,
    BotModule,
    ObservatoryModule,
    ScheduleModule.forRoot(),
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
          ObservatoryPostEntity,
          PostSchedulerEntity,
          SettingsEntity,
          CringePostEntity,
          PublishedPostHashesEntity,
          UserModeratedPostEntity,
          UserMessageModeratedPostEntity,
          YearResultEntity,
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
  ],
  controllers: [],
  providers: [AppService],
})
export class AppModule {}
