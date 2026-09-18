import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock } from './clock';
import { RANDOM, SystemRandom } from './random';

/**
 * Глобальный модуль с общими портами (seams) приложения.
 *
 * Предоставляет реализации системных часов и генератора случайных чисел
 * всему приложению, чтобы их можно было подменять в тестах.
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: RANDOM, useClass: SystemRandom },
  ],
  exports: [CLOCK, RANDOM],
})
export class SharedModule {}
