import { Logger } from '@nestjs/common';

/**
 * Порог схожести, начиная с которого посты считаются дубликатами.
 *
 * Вынесен единой точкой правды: ранее литерал `0.5` был продублирован в
 * `UserPostManagementService` и `ObservatoryService`.
 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.5;

/**
 * Результат сравнения хешей с «расстоянием» схожести.
 */
export interface HashDistance {
  /** Расстояние `0..1`; чем ближе к 1, тем более похожи посты. */
  distance: number;
}

/**
 * Минимальное описание запланированного поста для поиска дубликатов.
 */
export interface ScheduledPostCandidate {
  /** Идентификатор запланированного поста. */
  id: number;
  /** Хеш изображения; посты без хеша не сравниваются. */
  hash?: string | null;
  /** Дата публикации; посты без валидной даты не сравниваются. */
  publishDate?: Date | null;
}

/**
 * Источник запланированных постов (порт над `PostSchedulerService`).
 */
export interface ScheduledPostsSource {
  /** Возвращает все ещё не опубликованные запланированные посты. */
  getAllScheduledPosts(): Promise<ScheduledPostCandidate[]>;
}

/**
 * Калькулятор расстояния между хешами (порт над `DeduplicationService`).
 */
export interface HashDistanceCalculator {
  /**
   * Считает расстояние между двумя хешами.
   *
   * @param hash1 первый хеш
   * @param hash2 второй хеш
   * @returns расстояние `0..1`
   */
  calculateHashDistance(hash1: string, hash2: string): number;
}

/**
 * Найденный запланированный дубликат с наибольшей схожестью.
 */
export interface ScheduledDuplicate {
  /** Идентификатор запланированного поста. */
  postId: number;
  /** Расстояние схожести `0..1`. */
  distance: number;
  /** Дата публикации запланированного поста. */
  scheduledDate: Date;
}

/**
 * Проверяет, есть ли среди элементов хотя бы один дубликат по порогу схожести.
 *
 * Чистая функция — общая для `UserPostManagementService` и `ObservatoryService`,
 * чтобы порог `0.5` не дублировался по коду.
 *
 * @typeParam T тип элемента с полем `distance`
 * @param items кандидаты на сравнение
 * @param threshold порог схожести (по умолчанию {@link DUPLICATE_SIMILARITY_THRESHOLD})
 * @returns `true`, если есть элемент с `distance >= threshold`
 */
export function hasSimilarDistance<T extends HashDistance>(
  items: ReadonlyArray<T>,
  threshold: number = DUPLICATE_SIMILARITY_THRESHOLD
): boolean {
  return items.some((item) => item.distance >= threshold);
}

/**
 * Выбирает наиболее похожий элемент (с максимальным `distance`).
 *
 * При равных расстояниях возвращает последний — повторяет поведение исходного
 * `reduce` без начального значения (`prev > current ? prev : current`). На
 * пустом массиве бросает исключение, как и исходная реализация.
 *
 * @typeParam T тип элемента с полем `distance`
 * @param items непустой список кандидатов
 * @returns элемент с максимальным `distance`
 */
export function pickClosest<T extends HashDistance>(items: ReadonlyArray<T>): T {
  return items.reduce((prev, current) => (prev.distance > current.distance ? prev : current));
}

/**
 * Политика дубликатов постов.
 *
 * Содержит чистую проверку дат, проверку порога схожести и поиск наиболее
 * похожего запланированного поста. Зависимости отданы портами, поэтому класс
 * тестируется без Nest и без реальных сервисов. `UserPostManagementService`
 * оставляет у себя тонкие делегирующие обёртки (`checkScheduledDuplicates`,
 * `isValidDate`), которые использует существующая white-box спецификация.
 */
export class DuplicatePolicy {
  /**
   * @param scheduledPosts источник запланированных постов
   * @param hashes калькулятор расстояния между хешами
   * @param loggerContext контекст для `Logger.error` (по умолчанию имя класса)
   */
  constructor(
    private readonly scheduledPosts: ScheduledPostsSource,
    private readonly hashes: HashDistanceCalculator,
    private readonly loggerContext: string = DuplicatePolicy.name
  ) {}

  /**
   * Проверяет, что значение является валидной датой.
   *
   * Число `0` и пустые значения считаются отсутствием даты — как в исходной
   * реализации.
   *
   * @param date дата, строка или число
   * @returns `true`, если из значения получается валидный `Date`
   */
  public isValidDate(date: Date | string | number | null | undefined): boolean {
    if (!date) return false;

    const dateObj = date instanceof Date ? date : new Date(date);
    return !isNaN(dateObj.getTime());
  }

  /**
   * Проверяет наличие похожего поста по порогу схожести.
   *
   * @param items кандидаты, найденные внешним поиском
   * @returns `true`, если есть совпадение не ниже порога
   */
  public hasSimilar(items: ReadonlyArray<HashDistance>): boolean {
    return hasSimilarDistance(items);
  }

  /**
   * Ищет наиболее похожий запланированный пост.
   *
   * Повторяет исходную реализацию: без хеша или без постов возвращает `null`,
   * посты без хеша/валидной даты пропускаются, при совпадении не ниже порога
   * возвращается самый похожий. Любая ошибка загрузки расписания логируется и
   * трактуется как отсутствие дубликата.
   *
   * @param hash хеш нового изображения
   * @returns самый похожий запланированный пост или `null`
   */
  public async checkScheduledDuplicates(hash: string): Promise<ScheduledDuplicate | null> {
    if (!hash) return null;

    try {
      const scheduledPosts = await this.scheduledPosts.getAllScheduledPosts();

      if (!scheduledPosts || scheduledPosts.length === 0) return null;

      const potentialDuplicates: ScheduledDuplicate[] = [];

      for (const post of scheduledPosts) {
        if (post.hash && post.publishDate && this.isValidDate(post.publishDate)) {
          const distance = this.hashes.calculateHashDistance(hash, post.hash);

          if (distance >= DUPLICATE_SIMILARITY_THRESHOLD) {
            potentialDuplicates.push({
              postId: post.id,
              distance,
              scheduledDate: post.publishDate,
            });
          }
        }
      }

      if (potentialDuplicates.length > 0) {
        return pickClosest(potentialDuplicates);
      }

      return null;
    } catch (error) {
      Logger.error(
        `Failed to check scheduled duplicates: ${error.message}`,
        this.loggerContext
      );
      return null;
    }
  }
}
