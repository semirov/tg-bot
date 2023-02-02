import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';

@Injectable()
export class BaseConfigService {
  constructor(private configService: ConfigService) {
  }

  get botToken(): string {
    return this.configService.getOrThrow('BOT_TOKEN');
  }

  get ownerId(): number[] {
    return this.configService
      .getOrThrow<string>('BOT_OWNER_ID')
      .split(',')
      .map((id) => +id);
  }

  get memeChanelId(): number {
    return +this.configService.getOrThrow<string>('MANAGED_CHANNEL');
  }

  get userRequestMemeChannel(): number {
    return +this.configService.getOrThrow<string>('USER_REQUEST_CHANNEL');
  }

  get databaseHost(): string {
    return this.configService.getOrThrow<string>('DATABASE_HOST');
  }

  get databasePort(): number {
    return +this.configService.getOrThrow<string>('DATABASE_PORT');
  }

  get databaseUsername(): string {
    return this.configService.getOrThrow<string>('DATABASE_USERNAME');
  }

  get databasePassword(): string {
    return this.configService.getOrThrow<string>('DATABASE_PASSWORD');
  }

  get databaseName(): string {
    return this.configService.getOrThrow<string>('DATABASE_NAME');
  }
}
