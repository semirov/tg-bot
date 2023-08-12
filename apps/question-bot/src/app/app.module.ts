import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppConfigModule } from './modules/config/app-config.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BaseConfigService } from './modules/config/base-config.service';
import { SessionEntity } from './modules/bot/session/SessionEntity';
import { BotModule } from './modules/bot/bot.module';
import { ChannelsEntity } from './modules/bot/entities/channels.entity';
import { UserEntity } from './modules/bot/entities/user.entity';
import { MessagesEntity } from './modules/bot/entities/messages.entity';

@Module({
  imports: [
    AppConfigModule,
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule, BotModule],
      useFactory: (configService: BaseConfigService) => ({
        type: 'postgres',
        host: configService.databaseHost,
        port: configService.databasePort,
        username: configService.databaseUsername,
        password: configService.databasePassword,
        database: configService.databaseName,
        entities: [SessionEntity, UserEntity, ChannelsEntity, MessagesEntity],
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
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
