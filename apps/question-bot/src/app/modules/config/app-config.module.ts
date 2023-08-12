import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import configuration from './configuration';
import { BaseConfigService } from './base-config.service';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: false,
      load: [configuration],
    }),
  ],
  providers: [BaseConfigService],
  exports: [BaseConfigService],
})
export class AppConfigModule {}
