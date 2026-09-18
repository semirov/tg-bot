import { PublicationModesEnum } from './publication-modes.enum';

describe('PublicationModesEnum', () => {
  it('содержит все режимы публикации', () => {
    expect(PublicationModesEnum.NOW_SILENT).toBe('NOW_SILENT');
    expect(PublicationModesEnum.NEXT_INTERVAL).toBe('NEXT_INTERVAL');
    expect(PublicationModesEnum.NIGHT_CRINGE).toBe('NIGHT_CRINGE');
    expect(PublicationModesEnum.NEXT_MORNING).toBe('NEXT_MORNING');
    expect(PublicationModesEnum.NEXT_MIDDAY).toBe('NEXT_MIDDAY');
    expect(PublicationModesEnum.NEXT_EVENING).toBe('NEXT_EVENING');
    expect(PublicationModesEnum.NEXT_NIGHT).toBe('NEXT_NIGHT');
  });

  it('значения уникальны — режимы передаются строкой в свитч публикации', () => {
    const values = Object.values(PublicationModesEnum);
    expect(new Set(values).size).toBe(values.length);
  });
});
