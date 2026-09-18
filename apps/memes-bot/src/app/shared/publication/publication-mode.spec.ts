import { PublicationModesEnum } from '../../modules/post-management/constants/publication-modes.enum';
import {
  resolvePublicationModeSlot,
  runPublicationMode,
} from './publication-mode';

describe('resolvePublicationModeSlot', () => {
  it.each([
    [PublicationModesEnum.NOW_SILENT, 'now'],
    [PublicationModesEnum.NEXT_MORNING, 'scheduled'],
    [PublicationModesEnum.NEXT_MIDDAY, 'scheduled'],
    [PublicationModesEnum.NEXT_EVENING, 'scheduled'],
    [PublicationModesEnum.NEXT_INTERVAL, 'scheduled'],
    [PublicationModesEnum.NEXT_NIGHT, 'scheduled'],
    [PublicationModesEnum.NIGHT_CRINGE, 'nightCringe'],
  ])('сопоставляет %s со слотом %s', (mode, slot) => {
    expect(resolvePublicationModeSlot(mode as PublicationModesEnum)).toBe(slot);
  });

  it('возвращает undefined для неизвестного режима', () => {
    expect(resolvePublicationModeSlot('UNKNOWN' as PublicationModesEnum)).toBeUndefined();
  });
});

describe('runPublicationMode', () => {
  const buildHandlers = () => ({
    now: jest.fn(),
    scheduled: jest.fn(),
    nightCringe: jest.fn(),
  });

  it('NOW_SILENT вызывает now с контекстом и возвращает результат', () => {
    const handlers = buildHandlers();
    const result = { ok: true };
    handlers.now.mockReturnValue(result);
    const context = { id: 1 };

    expect(runPublicationMode(PublicationModesEnum.NOW_SILENT, handlers, context)).toBe(result);
    expect(handlers.now).toHaveBeenCalledWith(context);
    expect(handlers.scheduled).not.toHaveBeenCalled();
    expect(handlers.nightCringe).not.toHaveBeenCalled();
  });

  it.each([
    PublicationModesEnum.NEXT_MORNING,
    PublicationModesEnum.NEXT_MIDDAY,
    PublicationModesEnum.NEXT_EVENING,
    PublicationModesEnum.NEXT_INTERVAL,
    PublicationModesEnum.NEXT_NIGHT,
  ])('%s вызывает scheduled', (mode) => {
    const handlers = buildHandlers();
    const context = { id: 2 };

    runPublicationMode(mode as PublicationModesEnum, handlers, context);

    expect(handlers.scheduled).toHaveBeenCalledWith(context);
    expect(handlers.now).not.toHaveBeenCalled();
    expect(handlers.nightCringe).not.toHaveBeenCalled();
  });

  it('NIGHT_CRINGE вызывает nightCringe', () => {
    const handlers = buildHandlers();
    const context = { id: 3 };

    runPublicationMode(PublicationModesEnum.NIGHT_CRINGE, handlers, context);

    expect(handlers.nightCringe).toHaveBeenCalledWith(context);
    expect(handlers.now).not.toHaveBeenCalled();
    expect(handlers.scheduled).not.toHaveBeenCalled();
  });

  it('неизвестный режим не вызывает обработчики и возвращает undefined', () => {
    const handlers = buildHandlers();

    expect(
      runPublicationMode('UNKNOWN' as PublicationModesEnum, handlers, { id: 4 })
    ).toBeUndefined();
    expect(handlers.now).not.toHaveBeenCalled();
    expect(handlers.scheduled).not.toHaveBeenCalled();
    expect(handlers.nightCringe).not.toHaveBeenCalled();
  });
});
