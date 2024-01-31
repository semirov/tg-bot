/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import {NestFactory} from '@nestjs/core';

import {AppModule} from './app/app.module';
import {Transport} from "@nestjs/microservices";
import {AppConfigModule} from "./app/config/app-config.module";
import {BaseConfigService} from "./app/config/base-config.service";

async function bootstrap() {
  const configApp = await NestFactory.create(AppConfigModule);
  const configService = configApp.get(BaseConfigService);
  const app = await NestFactory.createMicroservice(AppModule, {
    transport: Transport.REDIS,
    options: {
      host: configService.redisHost,
      port: configService.redisPort,
      password: configService.redisPassword,
    },
  });
  app.enableShutdownHooks();
  await app.listen();
}

bootstrap();
