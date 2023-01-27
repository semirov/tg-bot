import { Module } from '@nestjs/common';
import { FilippMemesBotService } from './services/filipp-memes-bot.service';
import { HelloScene } from './scenes/hello.scene';
import { SendMemeScene } from './scenes/send-meme.scene';
import { RequestAdminScene } from './scenes/request-admin.scene';
import { MemeManagementService } from './services/meme-management.service';
import { AdminDialogScene } from './scenes/admin-dialog.scene';
import { AdminDialogManagementService } from './services/admin-dialog-management.service';
import {BaseConfigService} from "../../config/base-config.service";

@Module({
  imports: [
  ],
  providers: [
    FilippMemesBotService,
    HelloScene,
    SendMemeScene,
    RequestAdminScene,
    MemeManagementService,
    AdminDialogScene,
    AdminDialogManagementService,
    BaseConfigService
  ],
})
export class FilippMemesBotModule {}
