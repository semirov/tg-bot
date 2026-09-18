import { getMetadataArgsStorage } from 'typeorm';
import { YearResultEntity } from './year-result.entity';

const storage = getMetadataArgsStorage();

function columns(propertyName: string) {
  return storage.columns.filter(
    (item) => item.target === YearResultEntity && item.propertyName === propertyName
  );
}

function column(propertyName: string) {
  return columns(propertyName)[0];
}

describe('YearResultEntity', () => {
  it('id — автоинкрементный первичный ключ', () => {
    const generation = storage.generations.find(
      (item) => item.target === YearResultEntity && item.propertyName === 'id'
    );

    expect(column('id')?.options.primary).toBe(true);
    expect(generation?.strategy).toBe('increment');
  });

  it('year, userId — обязательные integer/bigint', () => {
    expect(column('year')?.options).toMatchObject({ type: 'integer' });
    expect(column('userId')?.options).toMatchObject({ type: 'bigint' });
  });

  it('профиль пользователя — nullable varchar', () => {
    expect(column('username')?.options).toMatchObject({ type: 'varchar', nullable: true });
    expect(column('firstName')?.options).toMatchObject({ type: 'varchar', nullable: true });
    expect(column('lastName')?.options).toMatchObject({ type: 'varchar', nullable: true });
  });

  it('счётчики total* — integer по умолчанию 0', () => {
    for (const counter of [
      'totalProposed',
      'totalPublished',
      'totalRejected',
      'totalCringe',
      'activeDays',
      'longestStreak',
    ]) {
      expect(column(counter)?.options).toMatchObject({ type: 'integer', default: 0 });
    }
  });

  it('даты firstProposalDate и mostProductiveDay — nullable timestamptz', () => {
    expect(column('firstProposalDate')?.options).toMatchObject({
      type: 'timestamptz',
      nullable: true,
    });
    expect(column('mostProductiveDay')?.options).toMatchObject({
      type: 'timestamptz',
      nullable: true,
    });
  });

  it('числовые метрики — nullable', () => {
    expect(column('averageTimeToPublication')?.options).toMatchObject({
      type: 'float',
      nullable: true,
    });
    expect(column('duplicatesCount')?.options).toMatchObject({
      type: 'integer',
      nullable: true,
    });
    expect(column('duplicatesPercentage')?.options).toMatchObject({
      type: 'float',
      nullable: true,
    });
    expect(column('mostActiveTimeOfDay')?.options).toMatchObject({
      type: 'varchar',
      nullable: true,
    });
  });

  it('approvalRate имеет продублированную регистрацию колонки (integer + float)', () => {
    const approvalRate = columns('approvalRate');

    expect(approvalRate).toHaveLength(2);
    expect(approvalRate.map((item) => item.options.type).sort()).toEqual(['float', 'integer']);
    expect(approvalRate.every((item) => item.options.nullable === true)).toBe(true);
  });

  it('mostProductiveDayCount не является колонкой (нет декоратора)', () => {
    expect(columns('mostProductiveDayCount')).toHaveLength(0);
  });

  it('isPublished — boolean по умолчанию false', () => {
    expect(column('isPublished')?.options).toMatchObject({ type: 'boolean', default: false });
  });

  it('createdAt/publishedAt — timestamptz', () => {
    expect(column('createdAt')?.options).toMatchObject({ type: 'timestamptz', default: 'NOW' });
    expect(column('publishedAt')?.options).toMatchObject({
      type: 'timestamptz',
      nullable: true,
    });
  });
});
