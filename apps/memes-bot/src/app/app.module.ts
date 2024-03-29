import { Module } from '@nestjs/common';

import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionEntity } from './modules/bot/session/session.entity';
import { MenuModule } from './modules/menus/menu.module';
import { BotModule } from './modules/bot/bot.module';
import { AppConfigModule } from './modules/config/app-config.module';
import { BaseConfigService } from './modules/config/base-config.service';
import { UserRequestEntity } from './modules/bot/entities/user-request.entity';
import { UserEntity } from './modules/bot/entities/user.entity';
import { ClientModule } from './modules/client/client.module';
import { ClientSessionEntity } from './modules/client/entities/client-session.entity';
import { ObservatoryModule } from './modules/observatory/observatory.module';
import { ObservatoryPostEntity } from './modules/observatory/entities/observatory-post.entity';
import { PostManagementModule } from './modules/post-management/post-management.module';
import { PostSchedulerEntity } from './modules/bot/entities/post-scheduler.entity';
import { CronModule } from './modules/cron/cron.module';
import { ScheduleModule } from '@nestjs/schedule';
import { SettingsEntity } from './modules/bot/entities/settings.entity';
import { CringePostEntity } from './modules/bot/entities/cringe-post.entity';
import { PublishedPostHashesEntity } from './modules/bot/entities/published-post-hashes.entity';
import { UserModeratedPostEntity } from './modules/observatory/entities/user-moderated-post.entity';
import { UserMessageModeratedPostEntity } from './modules/observatory/entities/user-message-moderated-post.entity';

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
  ],
  controllers: [],
  providers: [AppService],
})
export class AppModule {}
