import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BaseConfigService {
  constructor(private configService: ConfigService) {}

  get botToken(): string {
    return this.configService.getOrThrow('MEMES_BOT_TOKEN');
  }

  get adminIds(): number[] {
    return this.configService.getOrThrow<string>('ADMIN_IDS').split(',').map(id => +id);
  }

  get moderatorIds(): number[] {
    return this.configService.getOrThrow<string>('MODERATOR_IDS').split(',').map(id => +id);
  }

  get memeChanelId(): number {
    return +this.configService.getOrThrow<string>('MEMES_CHANNEL');
  }

  get testMemeChannel(): number {
    return +this.configService.getOrThrow<string>('TEST_MEMES_CHANNEL');
  }
}
