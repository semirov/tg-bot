import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BaseConfigService {
  constructor(private configService: ConfigService) {}

  get botToken(): string {
    return this.configService.getOrThrow('BOT_TOKEN');
  }

  get ownerId(): number {
    return +this.configService.getOrThrow<string>('BOT_OWNER_ID');
  }

  get memeChanelId(): number {
    return +this.configService.getOrThrow<string>('MANAGED_CHANNEL');
  }

  get bestMemeChanelId(): number {
    return +this.configService.getOrThrow<string>('BEST_MANAGED_CHANNEL');
  }

  get userRequestMemeChannel(): number {
    return +this.configService.getOrThrow<string>('USER_REQUEST_CHANNEL');
  }

  get cringeMemeChannelId(): number {
    return +this.configService.getOrThrow<string>('CRINGE_CHANNEL');
  }

  get observerChannel(): number {
    return +this.configService.getOrThrow<string>('OBSERVER_CHANNEL');
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

  get appApiId(): number {
    return +this.configService.getOrThrow<string>('APP_API_ID');
  }

  get appApiHash(): string {
    return this.configService.getOrThrow<string>('APP_API_HASH');
  }

  get tgEnv(): 'prod' | 'test' {
    return this.configService.getOrThrow<'prod' | 'test'>('TG_ENV');
  }

  get s3Endpoint(): string {
    return this.configService.getOrThrow<string>('S3_ENDPOINT');
  }

  get s3Region(): string {
    return this.configService.getOrThrow<string>('S3_REGION');
  }

  get s3Bucket(): string {
    return this.configService.getOrThrow<string>('S3_BUCKET');
  }

  get s3AccessKeyId(): string {
    return this.configService.getOrThrow<string>('S3_ACCESS_KEY_ID');
  }

  get s3SecretAccessKey(): string {
    return this.configService.getOrThrow<string>('S3_SECRET_ACCESS_KEY');
  }

  get monitorBotToken(): string {
    return this.configService.getOrThrow<string>('MONITOR_BOT_TOKEN');
  }

  get monitorMainChannel(): string {
    return this.configService.getOrThrow<string>('MONITOR_MAIN_CHANNEL');
  }

  get monitorBestChannel(): string {
    return this.configService.getOrThrow<string>('MONITOR_BEST_CHANNEL');
  }

  get mattermostBaseUrl(): string {
    return this.configService.get<string>('MATTERMOST_BASE_URL') || 'https://time.tbank.ru';
  }

  get mattermostToken(): string {
    return this.configService.get<string>('MATTERMOST_TOKEN') || 'wkthpwfpstrp3kt1xfau576q1y';
  }

  get mattermostChannelId(): string {
    return this.configService.get<string>('MATTERMOST_CHANNEL_ID') || 'cxbgr1bbi3ypzfc6nc53womtph';
  }

  /**
   * Публичный base URL для изображений (например S3 бакет).
   * Используется для вставки картинок в посты Time через Markdown.
   */
  get mattermostImageBaseUrl(): string {
    return this.configService.get<string>('MATTERMOST_IMAGE_BASE_URL') || '';
  }
}
