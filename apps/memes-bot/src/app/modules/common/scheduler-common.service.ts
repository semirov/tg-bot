import { PublicationModesEnum } from '../post-management/constants/publication-modes.enum';

export interface IntervalTimeInterface {
  hours: number;
  minutes: number;
  seconds: number;
}

export interface IntervalInterface {
  from: IntervalTimeInterface;
  to: IntervalTimeInterface;
}

export class SchedulerCommonService {
  private static readonly TIME_INTERVALS = {
    [PublicationModesEnum.NIGHT_CRINGE]: {
      from: { hours: 2, minutes: 0, seconds: 0 },
      to: { hours: 6, minutes: 0, seconds: 0 },
    },
    [PublicationModesEnum.NEXT_NIGHT]: {
      from: { hours: 0, minutes: 0, seconds: 0 },
      to: { hours: 8, minutes: 59, seconds: 59 },
    },
    [PublicationModesEnum.NEXT_MORNING]: {
      from: { hours: 9, minutes: 0, seconds: 0 },
      to: { hours: 12, minutes: 59, seconds: 59 },
    },
    [PublicationModesEnum.NEXT_MIDDAY]: {
      from: { hours: 13, minutes: 0, seconds: 0 },
      to: { hours: 18, minutes: 59, seconds: 59 },
    },
    [PublicationModesEnum.NEXT_EVENING]: {
      from: { hours: 19, minutes: 0, seconds: 0 },
      to: { hours: 23, minutes: 59, seconds: 59 },
    },
    [PublicationModesEnum.NEXT_INTERVAL]: {
      from: { hours: 9, minutes: 0, seconds: 0 },
      to: { hours: 23, minutes: 59, seconds: 59 },
    },
  };

  public static timeIntervalByMode(mode: PublicationModesEnum): IntervalInterface {
    return SchedulerCommonService.TIME_INTERVALS[mode];
  }
}
