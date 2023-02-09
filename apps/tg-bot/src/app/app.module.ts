import {Module} from '@nestjs/common';

import {AppService} from './app.service';
import {TypeOrmModule} from '@nestjs/typeorm';
import {SessionEntity} from './modules/bot/session/session.entity';
import {MenuModule} from './modules/menus/menu.module';
import {BotModule} from './modules/bot/bot.module';
import {AppConfigModule} from './modules/config/app-config.module';
import {BaseConfigService} from './modules/config/base-config.service';
import {UserRequestEntity} from './modules/bot/entities/user-request.entity';
import {UserEntity} from './modules/bot/entities/user.entity';
import {ClientModule} from './modules/client/client.module';
import {ClientSessionEntity} from './modules/client/entities/client-session.entity';
import {ObservatoryModule} from "./modules/observatory/observatory.module";
import {ObservatoryPostEntity} from "./modules/observatory/entities/observatory-post.entity";
import {PostManagementModule} from "./modules/post-management/post-management.module";

@Module({
  imports: [
    AppConfigModule,
    BotModule,
    ObservatoryModule,
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
    PostManagementModule,
    MenuModule,
    ClientModule,
  ],
  controllers: [],
  providers: [AppService],
})
export class AppModule {
}
