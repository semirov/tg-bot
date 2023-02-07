import {Module} from '@nestjs/common';

import {AppService} from './app.service';
import {TypeOrmModule} from '@nestjs/typeorm';
import {SessionEntity} from './modules/bot/session/session.entity';
import {ConversationsModule} from './modules/conversations/conversations.module';
import {MenuModule} from './modules/menus/menu.module';
import {BotModule} from './modules/bot/bot.module';
import {AppConfigModule} from './modules/config/app-config.module';
import {BaseConfigService} from './modules/config/base-config.service';
import {UserRequestEntity} from './modules/bot/entities/user-request.entity';
import {UserEntity} from './modules/bot/entities/user.entity';
import {environment} from '../environments/environment';
import {ClientModule} from './modules/client/client.module';
import {ClientSessionEntity} from './modules/client/entities/client-session.entity';
import {ObservatoryModule} from "./modules/observatory/observatory.module";
import {ObservatoryPostEntity} from "./modules/observatory/entities/observatory-post.entity";

@Module({
  imports: [
    AppConfigModule,
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      useFactory: (configService: BaseConfigService) => ({
        type: 'postgres',
        host: configService.databaseHost,
        port: configService.databasePort,
        username: configService.databaseUsername,
        password: configService.databasePassword,
        database: configService.databaseName,
        entities: [SessionEntity, UserRequestEntity, UserEntity, ClientSessionEntity, ObservatoryPostEntity],
        synchronize: true,
        extra: configService.useSSL ? {
          ssl: {
            rejectUnauthorized: false,
          },
        } : undefined,
      }),
      inject: [BaseConfigService],
    }),
    ObservatoryModule,
    ConversationsModule,
    MenuModule,
    BotModule,
    ClientModule,
  ],
  controllers: [],
  providers: [AppService],
})
export class AppModule {
}
