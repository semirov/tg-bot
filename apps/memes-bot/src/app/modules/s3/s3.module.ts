import { HttpModule } from '@nestjs/axios';
import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { ChannelPostMiddleware } from './middleware/channel-post.middleware';
import { MemeUploadService } from './services/meme-upload.service';
import { S3Service } from './services/s3.service';

@Module({
  imports: [AppConfigModule, HttpModule],
  providers: [S3Service, MemeUploadService, ChannelPostMiddleware],
  exports: [S3Service, MemeUploadService, ChannelPostMiddleware],
})
export class S3Module implements OnModuleInit {
  private readonly logger = new Logger(S3Module.name);

  constructor(private s3Service: S3Service) {}

  onModuleInit() {
    this.logger.log('S3 Module initialized');
  }
}
