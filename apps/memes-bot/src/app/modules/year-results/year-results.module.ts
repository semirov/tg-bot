import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotModule } from '../bot/bot.module';
import { CringePostEntity } from '../bot/entities/cringe-post.entity';
import { PostSchedulerEntity } from '../bot/entities/post-scheduler.entity';
import { PublishedPostHashesEntity } from '../bot/entities/published-post-hashes.entity';
import { UserRequestEntity } from '../bot/entities/user-request.entity';
import { AppConfigModule } from '../config/app-config.module';
import { ObservatoryPostEntity } from '../observatory/entities/observatory-post.entity';
import { YearResultEntity } from './entities/year-result.entity';
import { YearResultsService } from './services/year-results.service';

@Module({
  imports: [
    AppConfigModule,
    BotModule,
    TypeOrmModule.forFeature([
      YearResultEntity,
      UserRequestEntity,
      CringePostEntity,
      PublishedPostHashesEntity,
      PostSchedulerEntity,
      ObservatoryPostEntity,
    ]),
  ],
  providers: [YearResultsService],
  exports: [YearResultsService],
})
export class YearResultsModule {}
