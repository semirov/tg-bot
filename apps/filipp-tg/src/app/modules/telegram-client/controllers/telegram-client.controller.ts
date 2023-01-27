import { Controller, OnModuleInit } from '@nestjs/common';

@Controller('telegram-client')
export class TelegramClientController implements OnModuleInit {

  async onModuleInit(): Promise<void> {
  }
}
