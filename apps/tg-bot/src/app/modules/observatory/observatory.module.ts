import {Module} from '@nestjs/common';
import {ObservatoryService} from './services/observatory.service';
import {BotModule} from "../bot/bot.module";
import {AppConfigModule} from "../config/app-config.module";
import {ClientModule} from "../client/client.module";
import {TypeOrmModule} from "@nestjs/typeorm";
import {ObservatoryPostEntity} from "./entities/observatory-post.entity";

@Module({
  imports: [BotModule, AppConfigModule, ClientModule, TypeOrmModule.forFeature([ObservatoryPostEntity])],
  providers: [ObservatoryService],
})
export class ObservatoryModule {
}
