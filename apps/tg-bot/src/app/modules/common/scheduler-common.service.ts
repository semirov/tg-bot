import {PublicationModesEnum} from '../post-management/constants/publication-modes.enum';

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
    [PublicationModesEnum.NEXT_NIGHT]: {
      from: {hours: 0, minutes: 0, seconds: 0},
      to: {hours: 6, minutes: 0, seconds: 0},
    },
    [PublicationModesEnum.NEXT_MORNING]: {
      from: {hours: 6, minutes: 0, seconds: 0},
      to: {hours: 12, minutes: 0, seconds: 0},
    },
    [PublicationModesEnum.NEXT_MIDDAY]: {
      from: {hours: 12, minutes: 0, seconds: 0},
      to: {hours: 18, minutes: 0, seconds: 0},
    },
    [PublicationModesEnum.NEXT_EVENING]: {
      from: {hours: 18, minutes: 0, seconds: 0},
      to: {hours: 23, minutes: 59, seconds: 59},
    },
    [PublicationModesEnum.IN_QUEUE]: {
      from: {hours: 0, minutes: 0, seconds: 0},
      to: {hours: 23, minutes: 59, seconds: 59},
    },
  };

  public static timeIntervalByMode(mode: PublicationModesEnum): IntervalInterface {
    return SchedulerCommonService.TIME_INTERVALS[mode];
  }
}
