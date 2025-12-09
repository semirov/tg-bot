export interface YearGeneralStatistics {
  totalModeratedMessages: number;
  totalMemes: number;
  memesFromUsers: number;
  memesFromObservatory: number;
  totalProposedByUsers: number;
  textMessagesToAdmin: number;
  adminRepliedToMessages: number;
  adminReplyPercentage: number;
  cringeMemes: number;
  duplicatesFound: number;
  year: number;
  totalAuthors: number;
  activeDaysWithMemes: number;
  mostProductiveDay?: Date;
  mostProductiveDayCount?: number;
  mostActiveMonth?: string;
  mostActiveMonthCount?: number;
  leastActiveMonth?: string;
  leastActiveMonthCount?: number;
  mostPopularPublicationMode?: string;
  duplicatesPercentage?: number;
  averageTimeToModeration?: number; // в минутах
  averageTimeFromModerationToPublication?: number; // в часах
  longestQueueDate?: Date;
  longestQueueLength?: number;
  topDuplicateUser?: {
    username: string;
    firstName: string;
    lastName: string;
    duplicatesCount: number;
    duplicatesPercentage: number;
  };
}

export interface UserYearStatistics {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  totalProposed: number;
  totalPublished: number;
  totalRejected: number;
  totalCringe: number;
  firstProposalDate: Date;
  activeDays: number;
  longestStreak: number;
  mostProductiveDay?: Date;
  mostProductiveDayCount?: number;
  approvalRate?: number;
  averageTimeToPublication?: number;
  mostActiveTimeOfDay?: string;
  duplicatesCount?: number;
  duplicatesPercentage?: number;
}

export interface YearResultsPreview {
  general: YearGeneralStatistics;
  users: UserYearStatistics[];
}
