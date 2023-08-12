import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BaseConfigService {
  constructor(private configService: ConfigService) {}

  get botToken(): string {
    return this.configService.getOrThrow('CM_BOT_TOKEN');
  }

  get ownerId(): number {
    return +this.configService.getOrThrow<string>('CM_BOT_OWNER_ID');
  }

  get databaseHost(): string {
    return this.configService.getOrThrow<string>('CM_DATABASE_HOST');
  }

  get databasePort(): number {
    return +this.configService.getOrThrow<string>('CM_DATABASE_PORT');
  }

  get useSSL(): boolean {
    return this.configService.getOrThrow<string>('CM_USE_SSL') === 'true';
  }

  get databaseUsername(): string {
    return this.configService.getOrThrow<string>('CM_DATABASE_USERNAME');
  }

  get databasePassword(): string {
    return this.configService.getOrThrow<string>('CM_DATABASE_PASSWORD');
  }

  get databaseName(): string {
    return this.configService.getOrThrow<string>('CM_DATABASE_NAME');
  }
}
