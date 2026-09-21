import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotModule } from '../bot/bot.module';
import { ClientModule } from '../client/client.module';
import { TrollModule } from '../troll/troll.module';
import { AppConfigModule } from '../config/app-config.module';
import { ObservedPostEntity } from './entities/observed-post.entity';
import { ParserSettingsEntity } from './entities/parser-settings.entity';
import { SourceCandidateEntity } from './entities/source-candidate.entity';
import { SourceChannelEntity } from './entities/source-channel.entity';
import { ParserClientService } from './services/parser-client.service';
import { ParserSettingsService } from './services/parser-settings.service';
import { ParserMtprotoGuard } from './services/parser-mtproto-guard.service';
import { ParserRegistryService } from './services/parser-registry.service';
import { ParserCollectorService } from './services/parser-collector.service';
import { ParserEvaluatorService } from './services/parser-evaluator.service';
import { ParserDeliveryService } from './services/parser-delivery.service';
import { ParserSelectorService } from './services/parser-selector.service';
import { ParserDiscoveryService } from './services/parser-discovery.service';
import { ParserAiService } from './services/parser-ai.service';
import { ParserModerationService } from './services/parser-moderation.service';
import { ParserMenuService } from './services/parser-menu.service';
import { ParserService } from './services/parser.service';

/**
 * Параллельный парсер источников: registry → collector → evaluator →
 * selector → delivery в предложку («Парсер»-сетка) + discovery.
 * Модуль не трогает обсерваторию: обе схемы работают одновременно.
 */
@Module({
  imports: [
    BotModule,
    ClientModule,
    TrollModule,
    AppConfigModule,
    TypeOrmModule.forFeature([
      SourceChannelEntity,
      ObservedPostEntity,
      SourceCandidateEntity,
      ParserSettingsEntity,
    ]),
  ],
  providers: [
    ParserClientService,
    ParserSettingsService,
    ParserMtprotoGuard,
    ParserRegistryService,
    ParserCollectorService,
    ParserEvaluatorService,
    ParserDeliveryService,
    ParserSelectorService,
    ParserDiscoveryService,
    ParserAiService,
    ParserModerationService,
    ParserMenuService,
    ParserService,
  ],
  exports: [ParserSettingsService, ParserRegistryService, ParserMenuService, ParserModerationService],
})
export class ParserModule {}
