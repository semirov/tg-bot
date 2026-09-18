import { getMetadataArgsStorage } from 'typeorm';
import { TrollDefectEntity } from './troll-defect.entity';

const storage = getMetadataArgsStorage();

function column(propertyName: string) {
  return storage.columns.find(
    (item) => item.target === TrollDefectEntity && item.propertyName === propertyName
  );
}

describe('TrollDefectEntity', () => {
  it('зарегистрирована с индексом по источнику дефекта', () => {
    const index = storage.indices.find((item) => item.target === TrollDefectEntity);

    expect(index?.columns).toEqual(['sourceChatId', 'botMessageId']);
    expect(index?.unique).toBe(false);
  });

  it('id — автоинкрементный первичный ключ', () => {
    const generation = storage.generations.find(
      (item) => item.target === TrollDefectEntity && item.propertyName === 'id'
    );

    expect(column('id')?.options.primary).toBe(true);
    expect(generation?.strategy).toBe('increment');
  });

  it('обязательные поля разбора: botAnswer, reportedBy, reportedInChatId', () => {
    expect(column('botAnswer')?.options).toMatchObject({ type: 'text' });
    expect(column('reportedBy')?.options).toMatchObject({ type: 'bigint' });
    expect(column('reportedInChatId')?.options).toMatchObject({ type: 'bigint' });
  });

  it('nullable-поля источника ответа и контекста', () => {
    expect(column('sourceChatId')?.options).toMatchObject({ type: 'bigint', nullable: true });
    expect(column('sourceChatTitle')?.options).toMatchObject({
      type: 'varchar',
      nullable: true,
    });
    expect(column('botMessageId')?.options).toMatchObject({ type: 'int', nullable: true });
    expect(column('replyToMessageId')?.options).toMatchObject({ type: 'int', nullable: true });
    expect(column('replyToUserId')?.options).toMatchObject({ type: 'bigint', nullable: true });
    expect(column('replyToUserName')?.options).toMatchObject({
      type: 'varchar',
      nullable: true,
    });
    expect(column('replyToText')?.options).toMatchObject({ type: 'text', nullable: true });
    expect(column('context')?.options).toMatchObject({ type: 'text', nullable: true });
  });

  it('matchKind и severity ограничены varchar(16) и nullable', () => {
    expect(column('matchKind')?.options).toMatchObject({
      type: 'varchar',
      length: 16,
      nullable: true,
    });
    expect(column('severity')?.options).toMatchObject({
      type: 'varchar',
      length: 16,
      nullable: true,
    });
  });

  it('diagnosis — nullable text, createdAt — CreateDateColumn', () => {
    expect(column('diagnosis')?.options).toMatchObject({ type: 'text', nullable: true });
    expect(column('createdAt')?.mode).toBe('createDate');
    expect(column('createdAt')?.options.type).toBe('timestamp');
  });
});
