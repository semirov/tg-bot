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
import {ScheduleModule} from '@nestjs/schedule';
import {ClientsModule, Transport} from '@nestjs/microservices';
import {MicroservicesEnum} from '@chanellia/common';

@Module({
  imports: [
    AppConfigModule,
    BotModule,
    ScheduleModule.forRoot(),
    ClientsModule.registerAsync({
      clients: [
        {
          name: MicroservicesEnum.WORKER,
          imports: [AppConfigModule],
          useFactory: (configService: BaseConfigService) => ({
            transport: Transport.REDIS,
            options: {
              host: configService.redisHost,
              port: configService.redisPort,
              password: configService.redisPassword,
            },
          }),
          inject: [BaseConfigService],
        },
      ],
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      useFactory: (configService: BaseConfigService) => ({
        type: 'postgres',
        host: configService.databaseHost,
        port: configService.databasePort,
        username: configService.databaseUsername,
        password: configService.databasePassword,
        database: configService.databaseName,
        entities: [SessionEntity, ClientEntity],
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
