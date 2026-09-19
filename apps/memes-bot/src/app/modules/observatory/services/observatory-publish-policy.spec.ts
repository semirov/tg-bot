import { ScheduledPostContextInterface } from '../../bot/services/post-scheduler.service';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';
import { ObservatoryPublishPolicy } from './observatory-publish-policy';

function makeHandlers() {
  return {
    now: jest.fn(),
    scheduled: jest.fn(),
    nightCringe: jest.fn(),
  };
}

describe('ObservatoryPublishPolicy', () => {
  const context = { requestChannelMessageId: 1 } as ScheduledPostContextInterface;

  it('маршрутизирует now-режимы в обработчик now', () => {
    const handlers = makeHandlers();

    new ObservatoryPublishPolicy(handlers).run(PublicationModesEnum.NOW_SILENT, context);

    expect(handlers.now).toHaveBeenCalledWith(context);
    expect(handlers.scheduled).not.toHaveBeenCalled();
    expect(handlers.nightCringe).not.toHaveBeenCalled();
  });

  it('маршрутизирует scheduled-режимы в обработчик scheduled', () => {
    const handlers = makeHandlers();

    for (const mode of [
      PublicationModesEnum.NEXT_MORNING,
      PublicationModesEnum.NEXT_MIDDAY,
      PublicationModesEnum.NEXT_EVENING,
      PublicationModesEnum.NEXT_INTERVAL,
      PublicationModesEnum.NEXT_NIGHT,
    ]) {
      new ObservatoryPublishPolicy(handlers).run(mode, context);
    }

    expect(handlers.scheduled).toHaveBeenCalledTimes(5);
    expect(handlers.now).not.toHaveBeenCalled();
    expect(handlers.nightCringe).not.toHaveBeenCalled();
  });

  it('маршрутизирует NIGHT_CRINGE в обработчик nightCringe', () => {
    const handlers = makeHandlers();

    new ObservatoryPublishPolicy(handlers).run(PublicationModesEnum.NIGHT_CRINGE, context);

    expect(handlers.nightCringe).toHaveBeenCalledWith(context);
    expect(handlers.now).not.toHaveBeenCalled();
    expect(handlers.scheduled).not.toHaveBeenCalled();
  });

  it('для неизвестного режима возвращает undefined и не зовёт обработчики', () => {
    const handlers = makeHandlers();

    const result = new ObservatoryPublishPolicy(handlers).run(
      'UNKNOWN' as PublicationModesEnum,
      context
    );

    expect(result).toBeUndefined();
    expect(handlers.now).not.toHaveBeenCalled();
    expect(handlers.scheduled).not.toHaveBeenCalled();
    expect(handlers.nightCringe).not.toHaveBeenCalled();
  });

  it('возвращает результат выбранного обработчика', () => {
    const expected = Promise.resolve();
    const policy = new ObservatoryPublishPolicy({
      now: () => expected,
      scheduled: jest.fn(),
      nightCringe: jest.fn(),
    });

    expect(policy.run(PublicationModesEnum.NOW_SILENT, context)).toBe(expected);
  });
});
