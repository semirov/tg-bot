import { Module } from '@nestjs/common';
import { FilippMemesBotModule } from './modules/filipp-memes-bot/filipp-memes-bot.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { environment } from '../environments/environment';
import { TelegrafModule } from 'nestjs-telegraf';
import { MEME_BOT } from './modules/filipp-memes-bot/filipp-meme-bot.const';
import { session } from 'telegraf';
import * as process from 'process';
import config from './config/config.const';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [config],
    }),

    TelegrafModule.forRootAsync({
      botName: MEME_BOT,
      useFactory: (configService: ConfigService) => {
        return {
          token: configService.get(
            'MEMES_BOT_TOKEN',
            process.env.MEMES_BOT_TOKEN
          ),
          include: [FilippMemesBotModule],
          middlewares: [session()],
        };
      },
      inject: [ConfigService],
    }),
    FilippMemesBotModule,
  ],
})
export class AppModule {
  constructor() {

    console.log('environment.production' , environment.production);
  }
}
