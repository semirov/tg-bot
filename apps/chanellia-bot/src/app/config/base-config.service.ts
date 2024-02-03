import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';

@Injectable()
export class BaseConfigService {
  constructor(private configService: ConfigService) {
  }

  get botToken(): string {
    return this.configService.getOrThrow('MASTER_BOT_TOKEN');
  }

  get ownerId(): number {
    return +this.configService.getOrThrow<string>('BOT_OWNER_ID');
  }

  get databaseHost(): string {
    return this.configService.getOrThrow<string>('DATABASE_HOST');
  }

  get databasePort(): number {
    return +this.configService.getOrThrow<string>('DATABASE_PORT');
  }

  get useSSL(): boolean {
    return this.configService.getOrThrow<string>('USE_SSL') === 'true';
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

  get redisHost(): string {
    return this.configService.getOrThrow<string>('REDIS_HOST');
  }

  get redisPort(): number {
    return +this.configService.getOrThrow<number>('REDIS_PORT');
  }

  get redisPassword(): string {
    return this.configService.getOrThrow<string>('REDIS_PASSWORD');
  }
}
