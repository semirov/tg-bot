import { Module } from '@nestjs/common';
import { TelegramClientService } from './services/telegram-client.service';
import { TelegramClientController } from './controllers/telegram-client.controller';

@Module({
  controllers: [TelegramClientController],
  providers: [TelegramClientService],
})
export class TelegramClientModule {}
