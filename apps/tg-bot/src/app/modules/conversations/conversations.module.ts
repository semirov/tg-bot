import {Module} from '@nestjs/common';
import {BotModule} from '../bot/bot.module';
import {SendMemeConversation} from './send-meme.conversation';
import {UserAdminDialogConversation} from './user-admin-dialog.conversation';
import {AppConfigModule} from '../config/app-config.module';
import {ClientModule} from '../client/client.module';

@Module({
  imports: [BotModule, AppConfigModule, ClientModule],
  providers: [SendMemeConversation, UserAdminDialogConversation],
  exports: [SendMemeConversation],
})
export class ConversationsModule {
}
