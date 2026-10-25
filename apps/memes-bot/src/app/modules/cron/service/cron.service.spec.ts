jest.mock('@nestjs/schedule', () => {
  const actual = jest.requireActual('@nestjs/schedule');
  return {
    ...actual,
    Cron: () => () => undefined,
    Interval: () => () => undefined,
  };
});

jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

import { Logger } from '@nestjs/common';
import { GrammyError } from 'grammy';
import { CronService } from './cron.service';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';

function createService() {
  const postSchedulerService = {
    nextScheduledPost: jest.fn(),
    claimPostForPublish: jest.fn().mockResolvedValue(true),
    markPostAsPublished: jest.fn().mockResolvedValue(undefined),
    nowIsMode: jest.fn(),
  };
  const userPostManagementService = { onPublishNow: jest.fn().mockResolvedValue(undefined) };
  const observatoryService = { onPublishNow: jest.fn().mockResolvedValue(undefined) };
  const cringeManagementService = { moveCringeMessages: jest.fn().mockResolvedValue(undefined) };
  const monthlyStatService = { publishMonthlyStatistic: jest.fn() };
  const yearResultsService = { generateAndSendPreviewToOwner: jest.fn().mockResolvedValue(undefined) };
  const queueAlertService = { check: jest.fn().mockResolvedValue(undefined) };

  const service = new CronService(
    postSchedulerService as any,
    userPostManagementService as any,
    observatoryService as any,
    cringeManagementService as any,
    monthlyStatService as any,
    yearResultsService as any,
    queueAlertService as any
  );

  return {
    service,
    postSchedulerService,
    userPostManagementService,
    observatoryService,
    cringeManagementService,
    monthlyStatService,
    yearResultsService,
    queueAlertService,
  };
}

function makePost(overrides: any = {}): any {
  return {
    id: 5,
    mode: PublicationModesEnum.NEXT_MORNING,
    requestChannelMessageId: 10,
    processedByModerator: { id: 77 },
    caption: 'подпись',
    isUserPost: true,
    hash: 'hash-1',
    ...overrides,
  };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('CronService.handleCron', () => {
  it('запускает и публикацию по расписанию, и перенос кринжа', async () => {
    const { service } = createService();
    const nextSpy = jest
      .spyOn(service, 'handleNextScheduledPost')
      .mockResolvedValue(undefined);
    const moveSpy = jest
      .spyOn(service as any, 'tryToMoveCringe')
      .mockResolvedValue(undefined);

    await service.handleCron();

    expect(nextSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CronService.checkQueueAlerts', () => {
  it('дёргает сервис алертов очереди', async () => {
    const { service, queueAlertService } = createService();

    await service.checkQueueAlerts();

    expect(queueAlertService.check).toHaveBeenCalledTimes(1);
  });

  it('логирует ошибку и не пробрасывает её', async () => {
    const { service, queueAlertService } = createService();
    const failure = new Error('boom');
    queueAlertService.check.mockRejectedValue(failure);

    await expect(service.checkQueueAlerts()).resolves.toBeUndefined();

    expect(Logger.prototype.error).toHaveBeenCalledWith('Failed to check queue alerts', failure);
  });
});

describe('CronService.onCronTime', () => {
  it('публикует месячную статистику', async () => {
    const { service, monthlyStatService } = createService();

    await service.onCronTime();

    expect(monthlyStatService.publishMonthlyStatistic).toHaveBeenCalledTimes(1);
  });
});

describe('CronService.generateYearResults', () => {
  it('генерирует итоги за текущий год и логирует старт и завершение', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-12-25T10:00:00.000Z'));
    const { service, yearResultsService } = createService();

    await service.generateYearResults();

    expect(yearResultsService.generateAndSendPreviewToOwner).toHaveBeenCalledWith(2026);
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Starting automatic year results generation for 2026'
    );
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Year results generation completed for 2026'
    );
  });

  it('логирует ошибку генерации и не пробрасывает её', async () => {
    const { service, yearResultsService } = createService();
    const failure = new Error('generation failed');
    yearResultsService.generateAndSendPreviewToOwner.mockRejectedValue(failure);

    await expect(service.generateYearResults()).resolves.toBeUndefined();

    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to generate year results:',
      failure
    );
  });
});

describe('CronService.handleNextScheduledPost', () => {
  it('выходит, когда нет запланированного поста', async () => {
    const { service, postSchedulerService } = createService();
    postSchedulerService.nextScheduledPost.mockResolvedValue(null);

    await service.handleNextScheduledPost();

    expect(postSchedulerService.nextScheduledPost).toHaveBeenCalledTimes(1);
    expect(postSchedulerService.claimPostForPublish).not.toHaveBeenCalled();
    expect(postSchedulerService.markPostAsPublished).not.toHaveBeenCalled();
  });

  it('(TGB-117) не публикует пост, который уже забрал другой обработчик', async () => {
    const { service, postSchedulerService, userPostManagementService, observatoryService } =
      createService();
    postSchedulerService.nextScheduledPost.mockResolvedValue(makePost());
    postSchedulerService.claimPostForPublish.mockResolvedValue(false);

    await service.handleNextScheduledPost();

    expect(postSchedulerService.claimPostForPublish).toHaveBeenCalledWith(5);
    expect(userPostManagementService.onPublishNow).not.toHaveBeenCalled();
    expect(observatoryService.onPublishNow).not.toHaveBeenCalled();
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'publish source=cron sched=5 card=10 claim=already-claimed outcome=skipped'
    );
  });

  it('публикует пользовательский пост через UserPostManagementService', async () => {
    const { service, postSchedulerService, userPostManagementService, observatoryService } =
      createService();
    const post = makePost();
    postSchedulerService.nextScheduledPost.mockResolvedValue(post);

    await service.handleNextScheduledPost();

    expect(postSchedulerService.claimPostForPublish).toHaveBeenCalledWith(5);
    expect(userPostManagementService.onPublishNow).toHaveBeenCalledWith({
      mode: PublicationModesEnum.NEXT_MORNING,
      requestChannelMessageId: 10,
      processedByModerator: 77,
      caption: 'подпись',
      isUserPost: true,
      hash: 'hash-1',
      source: 'cron',
    });
    expect(observatoryService.onPublishNow).not.toHaveBeenCalled();
    // Claim и есть отметка о публикации — отдельного markPostAsPublished нет.
    expect(postSchedulerService.markPostAsPublished).not.toHaveBeenCalled();
  });

  it('публикует пост обсерватории, когда isUserPost false', async () => {
    const { service, postSchedulerService, userPostManagementService, observatoryService } =
      createService();
    postSchedulerService.nextScheduledPost.mockResolvedValue(makePost({ isUserPost: false }));

    await service.handleNextScheduledPost();

    expect(observatoryService.onPublishNow).toHaveBeenCalledTimes(1);
    expect(userPostManagementService.onPublishNow).not.toHaveBeenCalled();
    expect(postSchedulerService.markPostAsPublished).not.toHaveBeenCalled();
  });

  it('(TGB-117) два последовательных тика публикуют карточку ровно один раз', async () => {
    const { service, postSchedulerService, observatoryService } = createService();
    // Первый тик получает пост, второй читает ту же (устаревшую) строку —
    // ровно гонка из инцидента.
    const post = makePost({ isUserPost: false });
    postSchedulerService.nextScheduledPost.mockResolvedValue(post);
    let claimed = false;
    postSchedulerService.claimPostForPublish.mockImplementation(async () => {
      if (claimed) {
        return false;
      }
      claimed = true;
      return true;
    });
    observatoryService.onPublishNow.mockResolvedValue(20823);

    await service.handleNextScheduledPost();
    await service.handleNextScheduledPost();

    expect(postSchedulerService.claimPostForPublish).toHaveBeenCalledTimes(2);
    // onPublishNow — граница публикации, внутри неё ровно один copyMessage.
    expect(observatoryService.onPublishNow).toHaveBeenCalledTimes(1);
  });

  it('ловит ошибку публикации и не снимает claim (fail closed)', async () => {
    const { service, postSchedulerService, userPostManagementService } = createService();
    const failure = new Error('publish failed');
    postSchedulerService.nextScheduledPost.mockResolvedValue(makePost());
    userPostManagementService.onPublishNow.mockRejectedValue(failure);

    await expect(service.handleNextScheduledPost()).resolves.toBeUndefined();

    // warn: claim взят, но отправка упала — оператор должен снять claim вручную.
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'publish source=cron sched=5 card=10 claim=claimed outcome=error:Error'
    );
    expect(Logger.prototype.error).not.toHaveBeenCalled();
    // Claim не снимаем и повторно не помечаем: дубликат хуже пропуска.
    expect(postSchedulerService.claimPostForPublish).toHaveBeenCalledTimes(1);
    expect(postSchedulerService.markPostAsPublished).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('битая запись (нет модератора) не сжигает claim молча: warn со sched', async () => {
    const { service, postSchedulerService, observatoryService } = createService();
    postSchedulerService.nextScheduledPost.mockResolvedValue(
      makePost({ isUserPost: false, processedByModerator: null })
    );

    await expect(service.handleNextScheduledPost()).resolves.toBeUndefined();

    expect(observatoryService.onPublishNow).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'publish source=cron sched=5 card=10 claim=claimed outcome=error:TypeError'
    );
  });

  it('(TGB-117) два одновременных тика публикуют карточку ровно один раз', async () => {
    const { service, postSchedulerService, observatoryService } = createService();
    // Гонка из инцидента: оба тика видят одну и ту же непомеченную строку.
    postSchedulerService.nextScheduledPost.mockResolvedValue(makePost({ isUserPost: false }));
    const claimedIds = new Set<number>();
    postSchedulerService.claimPostForPublish.mockImplementation(async (id: number) => {
      // Уступаем управление — тики чередуются, как два параллельных UPDATE.
      await Promise.resolve();
      if (claimedIds.has(id)) {
        return false;
      }
      claimedIds.add(id);
      return true;
    });
    observatoryService.onPublishNow.mockResolvedValue(20823);

    await Promise.all([service.handleNextScheduledPost(), service.handleNextScheduledPost()]);

    expect(postSchedulerService.claimPostForPublish).toHaveBeenCalledTimes(2);
    expect(observatoryService.onPublishNow).toHaveBeenCalledTimes(1);
  });

  it('логирует GrammyError с описанием Telegram в лейбле ошибки', async () => {
    const { service, postSchedulerService, observatoryService } = createService();
    postSchedulerService.nextScheduledPost.mockResolvedValue(makePost({ isUserPost: false }));
    observatoryService.onPublishNow.mockRejectedValue(
      new GrammyError(
        "Call to 'copyMessage' failed!",
        { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
        'copyMessage',
        {}
      )
    );

    await service.handleNextScheduledPost();

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'publish source=cron sched=5 card=10 claim=claimed ' +
        'outcome=error:GrammyError:Bad Request: chat not found'
    );
  });

  it('на не-Error отказе пишет UnknownError без тела исключения', async () => {
    const { service, postSchedulerService, observatoryService } = createService();
    postSchedulerService.nextScheduledPost.mockResolvedValue(makePost({ isUserPost: false }));
    observatoryService.onPublishNow.mockRejectedValue('boom');

    await service.handleNextScheduledPost();

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'publish source=cron sched=5 card=10 claim=claimed outcome=error:UnknownError'
    );
  });
});

describe('CronService.tryToMoveCringe', () => {
  it('не переносит кринж в ночном режиме', async () => {
    const { service, postSchedulerService, cringeManagementService } = createService();
    postSchedulerService.nowIsMode.mockReturnValue(true);

    await (service as any).tryToMoveCringe();

    expect(postSchedulerService.nowIsMode).toHaveBeenCalledWith(
      PublicationModesEnum.NIGHT_CRINGE
    );
    expect(cringeManagementService.moveCringeMessages).not.toHaveBeenCalled();
  });

  it('переносит кринж вне ночного режима', async () => {
    const { service, postSchedulerService, cringeManagementService } = createService();
    postSchedulerService.nowIsMode.mockReturnValue(false);

    await (service as any).tryToMoveCringe();

    expect(cringeManagementService.moveCringeMessages).toHaveBeenCalledTimes(1);
  });
});
