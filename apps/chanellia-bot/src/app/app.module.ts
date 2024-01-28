import {Module} from '@nestjs/common';

import {AppConfigModule} from './config/app-config.module';
import {TypeOrmModule} from '@nestjs/typeorm';
import {ClientEntity} from './bot/entities/client.entity';
import {SessionEntity} from './bot/entities/session.entity';
import {BaseConfigService} from './config/base-config.service';
import {BotModule} from './bot/bot.module';
import {BullModule} from '@nestjs/bullmq';
import {BullBoardModule} from '@bull-board/nestjs';
import {ExpressAdapter} from '@bull-board/express';
import {BotsManagerModule} from './bots-manager/bots-manager.module';
import {BotsSessionEntity} from './bots-manager/entities/bots-session.entity';
import {BotsUsersEntity} from './bots-manager/entities/bots-users.entity';

@Module({
  imports: [
    AppConfigModule,
    BotModule,
    BotsManagerModule,
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      useFactory: (configService: BaseConfigService) => ({
        type: 'postgres',
        host: configService.databaseHost,
        port: configService.databasePort,
        username: configService.databaseUsername,
        password: configService.databasePassword,
        database: configService.databaseName,
        entities: [SessionEntity, ClientEntity, BotsSessionEntity, BotsUsersEntity],
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
    BullModule.forRootAsync({
      imports: [AppConfigModule],
      useFactory: (configService: BaseConfigService) => ({
        connection: {
          host: configService.redisHost,
          port: configService.redisPort,
          password: configService.redisPassword,
        },
      }),
      inject: [BaseConfigService],
    }),
    BullBoardModule.forRoot({
      route: '/queues',
      adapter: ExpressAdapter,
    }),
  ],
})
export class AppModule {
}
