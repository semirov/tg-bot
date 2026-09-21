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
import { CronService } from './cron.service';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';

function createService() {
  const postSchedulerService = {
    nextScheduledPost: jest.fn(),
    getScheduledPostById: jest.fn().mockResolvedValue({ id: 5, isPublished: false }),
    markPostAsPublished: jest.fn().mockResolvedValue(undefined),
    nowIsMode: jest.fn(),
  };
  const userPostManagementService = { onPublishNow: jest.fn().mockResolvedValue(undefined) };
  const observatoryService = { onPublishNow: jest.fn().mockResolvedValue(undefined) };
  const cringeManagementService = { moveCringeMessages: jest.fn().mockResolvedValue(undefined) };
  const monthlyStatService = { publishMonthlyStatistic: jest.fn() };
  const yearResultsService = { generateAndSendPreviewToOwner: jest.fn().mockResolvedValue(undefined) };

  const service = new CronService(
    postSchedulerService as any,
    userPostManagementService as any,
    observatoryService as any,
    cringeManagementService as any,
    monthlyStatService as any,
    yearResultsService as any
  );

  return {
    service,
    postSchedulerService,
    userPostManagementService,
    observatoryService,
    cringeManagementService,
    monthlyStatService,
    yearResultsService,
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

    expect(postSchedulerService.markPostAsPublished).not.toHaveBeenCalled();
    expect(postSchedulerService.nextScheduledPost).toHaveBeenCalledTimes(1);
  });

  it('не публикует снятый пост: записи в сетке уже нет', async () => {
    const { service, postSchedulerService, userPostManagementService, observatoryService } =
      createService();
    postSchedulerService.nextScheduledPost.mockResolvedValue(makePost());
    postSchedulerService.getScheduledPostById.mockResolvedValue(null);

    await service.handleNextScheduledPost();

    expect(postSchedulerService.getScheduledPostById).toHaveBeenCalledWith(5);
    expect(userPostManagementService.onPublishNow).not.toHaveBeenCalled();
    expect(observatoryService.onPublishNow).not.toHaveBeenCalled();
    expect(postSchedulerService.markPostAsPublished).not.toHaveBeenCalled();
  });

  it('не публикует уже опубликованный пост (isPublished)', async () => {
    const { service, postSchedulerService, observatoryService } = createService();
    postSchedulerService.nextScheduledPost.mockResolvedValue(makePost({ isUserPost: false }));
    postSchedulerService.getScheduledPostById.mockResolvedValue({ id: 5, isPublished: true });

    await service.handleNextScheduledPost();

    expect(observatoryService.onPublishNow).not.toHaveBeenCalled();
    expect(postSchedulerService.markPostAsPublished).not.toHaveBeenCalled();
  });

  it('публикует пользовательский пост через UserPostManagementService', async () => {
    const { service, postSchedulerService, userPostManagementService, observatoryService } =
      createService();
    const post = makePost();
    postSchedulerService.nextScheduledPost.mockResolvedValue(post);

    await service.handleNextScheduledPost();

    expect(userPostManagementService.onPublishNow).toHaveBeenCalledWith({
      mode: PublicationModesEnum.NEXT_MORNING,
      requestChannelMessageId: 10,
      processedByModerator: 77,
      caption: 'подпись',
      isUserPost: true,
      hash: 'hash-1',
    });
    expect(observatoryService.onPublishNow).not.toHaveBeenCalled();
    expect(postSchedulerService.markPostAsPublished).toHaveBeenCalledWith(5);
  });

  it('публикует пост обсерватории, когда isUserPost false', async () => {
    const { service, postSchedulerService, userPostManagementService, observatoryService } =
      createService();
    postSchedulerService.nextScheduledPost.mockResolvedValue(makePost({ isUserPost: false }));

    await service.handleNextScheduledPost();

    expect(observatoryService.onPublishNow).toHaveBeenCalledTimes(1);
    expect(userPostManagementService.onPublishNow).not.toHaveBeenCalled();
    expect(postSchedulerService.markPostAsPublished).toHaveBeenCalledWith(5);
  });

  it('перехватывает ошибку публикации, но всё равно помечает пост опубликованным', async () => {
    const { service, postSchedulerService, userPostManagementService } = createService();
    const failure = new Error('publish failed');
    postSchedulerService.nextScheduledPost.mockResolvedValue(makePost());
    userPostManagementService.onPublishNow.mockRejectedValue(failure);

    await service.handleNextScheduledPost();

    expect(console.error).toHaveBeenCalledWith('error while publish scheduled post', failure);
    expect(postSchedulerService.markPostAsPublished).toHaveBeenCalledWith(5);
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
