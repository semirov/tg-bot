import { Injectable, Logger } from '@nestjs/common';
import { BaseConfigService } from '../config/base-config.service';
import axios, { AxiosInstance } from 'axios';
import * as FormData from 'form-data';

export interface MattermostPostParams {
  message: string;
  fileUrl?: string;
  fileName?: string;
}

@Injectable()
export class MattermostService {
  private readonly logger = new Logger(MattermostService.name);
  private readonly client: AxiosInstance;

  constructor(private baseConfigService: BaseConfigService) {
    this.client = axios.create({
      baseURL: this.baseConfigService.mattermostBaseUrl,
      headers: {
        Authorization: `Bearer ${this.baseConfigService.mattermostToken}`,
      },
    });
  }

  /**
   * Отправить пост с файлом в канал Mattermost.
   * Файл скачивается по URL (из Telegram), загружается в Time/Mattermost,
   * и прикрепляется к посту через file_ids (клиент Time сам рендерит изображения).
   */
  public async sendPostWithFile(params: MattermostPostParams): Promise<void> {
    try {
      const channelId = this.baseConfigService.mattermostChannelId;
      let fileIds: string[] = [];

      if (params.fileUrl) {
        fileIds = await this.uploadFile(channelId, params.fileUrl, params.fileName);
      }

      const message = params.message || '';

      await this.client.post('/api/v4/posts', {
        channel_id: channelId,
        message,
        file_ids: fileIds,
      });

      this.logger.log('Post sent to Mattermost successfully');
    } catch (error) {
      this.logger.error('Failed to send post to Mattermost:', error);
      // Не пробрасываем ошибку, чтобы не ломать основной поток публикации в TG
    }
  }

  /**
   * Скачать файл из Telegram и загрузить в Mattermost.
   * Возвращает массив с ID загруженного файла.
   */
  private async uploadFile(
    channelId: string,
    fileUrl: string,
    fileName?: string
  ): Promise<string[]> {
    try {
      // Скачиваем файл из Telegram
      const fileResponse = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
      });

      const buffer = Buffer.from(fileResponse.data);
      const contentType = fileResponse.headers['content-type'] || 'application/octet-stream';

      // Определяем расширение из URL или content-type
      let ext = '';
      const urlMatch = fileUrl.match(/\.(jpg|jpeg|png|gif|webp|mp4|mov)(\?|$)/i);
      if (urlMatch) {
        ext = `.${urlMatch[1].toLowerCase()}`;
      } else if (contentType.includes('jpeg') || contentType.includes('jpg')) {
        ext = '.jpg';
      } else if (contentType.includes('png')) {
        ext = '.png';
      } else if (contentType.includes('gif')) {
        ext = '.gif';
      } else if (contentType.includes('webp')) {
        ext = '.webp';
      }

      const finalFileName = fileName ? `${fileName}${ext}` : `meme${ext}`;

      // Загружаем в Mattermost
      const form = new FormData();
      form.append('channel_id', channelId);
      form.append('files', buffer, {
        filename: finalFileName,
        contentType,
      });

      const uploadResponse = await this.client.post('/api/v4/files', form, {
        headers: form.getHeaders(),
      });

      this.logger.log(`Upload response data: ${JSON.stringify(uploadResponse.data)}`);

      const fileInfos: Array<{ id: string }> = uploadResponse.data?.file_infos || [];
      return fileInfos.map((f) => f.id);
    } catch (error) {
      this.logger.error('Failed to upload file to Mattermost:', error);
      return [];
    }
  }
}
