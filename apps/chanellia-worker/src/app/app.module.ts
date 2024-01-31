import {Module} from '@nestjs/common';
import {TypeOrmModule} from '@nestjs/typeorm';
import {BullModule} from '@nestjs/bullmq';
import {AppConfigModule} from './config/app-config.module';
import {BaseConfigService} from './config/base-config.service';
import {BotsSessionEntity} from './bots-manager/entities/bots-session.entity';
import {BotsUsersEntity} from './bots-manager/entities/bots-users.entity';
import {BotsManagerModule} from './bots-manager/bots-manager.module';

@Module({
  imports: [
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
        entities: [BotsSessionEntity, BotsUsersEntity],
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
  ],
})
export class AppModule {
}
