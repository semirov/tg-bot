import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { DeepSeekService } from './services/deepseek.service';

/**
 * Нейтральный LLM-модуль: клиент DeepSeek для AI-функций (классификация
 * каналов-кандидатов и префильтр постов парсера). Настройки лимитов и модели
 * берутся из env через BaseConfigService.
 */
@Module({
  imports: [AppConfigModule],
  providers: [DeepSeekService],
  exports: [DeepSeekService],
})
export class LlmModule {}
