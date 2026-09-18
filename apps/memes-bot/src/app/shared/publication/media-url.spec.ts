import { buildTelegramFileUrl, extractTelegramFileId } from './media-url';

describe('extractTelegramFileId', () => {
  it('берёт последний (самый крупный) размер фото', () => {
    expect(
      extractTelegramFileId({ photo: [{ file_id: 'small' }, { file_id: 'big' }] })
    ).toBe('big');
  });

  it('поддерживает video, document и animation', () => {
    expect(extractTelegramFileId({ video: { file_id: 'v' } })).toBe('v');
    expect(extractTelegramFileId({ document: { file_id: 'd' } })).toBe('d');
    expect(extractTelegramFileId({ animation: { file_id: 'a' } })).toBe('a');
  });

  it('возвращает undefined без медиа', () => {
    expect(extractTelegramFileId({})).toBeUndefined();
  });
});

describe('buildTelegramFileUrl', () => {
  it('строит продакшен-ссылку', () => {
    expect(buildTelegramFileUrl('TOKEN', 'photos/file.jpg')).toBe(
      'https://api.telegram.org/file/botTOKEN/photos/file.jpg'
    );
  });

  it('добавляет сегмент /test в тестовом окружении', () => {
    expect(buildTelegramFileUrl('TOKEN', 'photos/file.jpg', 'test')).toBe(
      'https://api.telegram.org/file/botTOKEN/test/photos/file.jpg'
    );
  });
});
