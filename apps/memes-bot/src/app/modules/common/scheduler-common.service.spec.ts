import { SchedulerCommonService } from './scheduler-common.service';
import { PublicationModesEnum } from '../post-management/constants/publication-modes.enum';

describe('SchedulerCommonService', () => {
  it.each([
    [PublicationModesEnum.NIGHT_CRINGE, 2, 0, 0, 6, 0, 0],
    [PublicationModesEnum.NEXT_NIGHT, 0, 0, 0, 8, 59, 59],
    [PublicationModesEnum.NEXT_MORNING, 9, 0, 0, 12, 59, 59],
    [PublicationModesEnum.NEXT_MIDDAY, 13, 0, 0, 18, 59, 59],
    [PublicationModesEnum.NEXT_EVENING, 19, 0, 0, 23, 59, 59],
    [PublicationModesEnum.NEXT_INTERVAL, 9, 0, 0, 23, 59, 59],
  ])(
    'timeIntervalByMode(%s) отдаёт корректное окно',
    (mode, fh, fm, fs, th, tm, ts) => {
      expect(SchedulerCommonService.timeIntervalByMode(mode as PublicationModesEnum)).toEqual({
        from: { hours: fh, minutes: fm, seconds: fs },
        to: { hours: th, minutes: tm, seconds: ts },
      });
    }
  );
});
