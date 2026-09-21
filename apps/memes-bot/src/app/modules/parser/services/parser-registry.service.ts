import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Inject } from '@nestjs/common';
import { LessThan, MoreThan, Repository } from 'typeorm';
import * as bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { TotalList } from 'telegram/Helpers';
import { CLOCK, Clock } from '../../../shared/clock';
import { BaseConfigService } from '../../config/base-config.service';
import { SCAN_WINDOW_HOURS, SourceCategory, SourceStatus } from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity, StoredBaseline } from '../entities/source-channel.entity';
import { computeBaseline, ChannelBaseline } from '../domain/parser-scoring';
import { COOLDOWN_DAYS, TAKEN_STALE_DAYS, computeSourceInterest } from '../domain/parser-source-weight';
import { POSITIVE_REACTIONS } from '../constants/parser.constants';
import { ParserMtprotoGuard } from './parser-mtproto-guard.service';
import { ParserClientService } from './parser-client.service';
import { ParserSettingsService } from './parser-settings.service';
import { normalizeChatId } from '../domain/parser-cross-links';

/** Реестр источников парсера: импорт, статистика, базлайны, прунинг. */
@Injectable()
export class ParserRegistryService {
  private readonly logger = new Logger(ParserRegistryService.name);

  constructor(
    @InjectRepository(SourceChannelEntity)
    private readonly sourceRepository: Repository<SourceChannelEntity>,
    @InjectRepository(ObservedPostEntity)
    private readonly observedRepository: Repository<ObservedPostEntity>,
    private readonly config: BaseConfigService,
    private readonly guard: ParserMtprotoGuard,
    private readonly parserClient: ParserClientService,
    private readonly settings: ParserSettingsService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  public get repository(): Repository<SourceChannelEntity> {
    return this.sourceRepository;
  }

  /** Активные и web-only источники, не находящиеся в чёрном списке. */
  public listCollectible(): Promise<SourceChannelEntity[]> {
    return this.sourceRepository.find({
      where: [
        { status: SourceStatus.ACTIVE, excluded: false },
        { status: SourceStatus.WEB_ONLY, excluded: false },
      ],
    });
  }

  /** Все источники в чёрном списке (для меню). */
  public listExcluded(): Promise<SourceChannelEntity[]> {
    return this.sourceRepository.find({ where: { excluded: true }, order: { excludedAt: 'DESC' } });
  }

  /** Топ источников по интересу владельца (взятые посты, затем вес). */
  public listPopular(limit = 10, offset = 0): Promise<SourceChannelEntity[]> {
    return this.sourceRepository.find({
      where: { excluded: false },
      order: { takenTotal: 'DESC', weight: 'DESC', id: 'ASC' },
      take: limit,
      skip: offset,
    });
  }

  /** Источник в чёрном списке? */
  public async isExcluded(chatId: string | number): Promise<boolean> {
    const source = await this.sourceRepository.findOne({ where: { chatId: String(chatId) } });
    return Boolean(source?.excluded);
  }

  public listAll(): Promise<SourceChannelEntity[]> {
    return this.sourceRepository.find({ order: { id: 'ASC' } });
  }

  public async countCollectible(): Promise<number> {
    return this.sourceRepository.count({
      where: [
        { status: SourceStatus.ACTIVE, excluded: false },
        { status: SourceStatus.WEB_ONLY, excluded: false },
      ],
    });
  }

  /**
   * Одноразовый импорт текущих подписок аккаунта: диалоги-каналы (не
   * мегагруппы) записываются в реестр как активные источники.
   */
  public async importSubscriptions(): Promise<number> {
    const client = this.parserClient.client();
    if (!client) return 0;

    const dialogs = await this.guard.run('getDialogs', () => client.getDialogs({ limit: 200 }));
    if (!dialogs) {
      this.logger.warn('Parser: не удалось получить диалоги для импорта');
      return 0;
    }

    let created = 0;
    for (const dialog of dialogs) {
      const entity = dialog.entity;
      if (!(entity instanceof Api.Channel) || entity.broadcast !== true) continue;
      const rawId = Number(entity.id.toString());
      const chatId = normalizeChatId(rawId);
      if (this.isOwnChannel(chatId)) continue;

      const exists = await this.sourceRepository.findOne({ where: { chatId: String(chatId) } });
      if (exists) continue;

      const source = this.sourceRepository.create({
        chatId: String(chatId),
        rawChatId: String(rawId),
        username: entity.username ?? null,
        title: entity.title ?? null,
        category: SourceCategory.MEMES,
        status: SourceStatus.ACTIVE,
      });
      await this.sourceRepository.save(source);
      created += 1;
    }

    this.logger.log(`Parser: импортировано источников из подписок: ${created}`);
    return created;
  }

  /** Добавляет источник по данным сущности канала (web-only или активный). */
  public async addSource(params: {
    chatId: number;
    rawChatId?: number | null;
    username?: string | null;
    title?: string | null;
    status?: SourceStatus;
    category?: SourceCategory;
  }): Promise<SourceChannelEntity | null> {
    const chatId = String(params.chatId);
    const exists = await this.sourceRepository.findOne({ where: { chatId } });
    if (exists) {
      if (exists.excluded) {
        this.logger.debug(`Parser: источник ${chatId} в чёрном списке — добавление отклонено`);
        return null;
      }
      return exists;
    }

    const source = this.sourceRepository.create({
      chatId,
      rawChatId: params.rawChatId != null ? String(params.rawChatId) : null,
      username: params.username ?? null,
      title: params.title ?? null,
      category: params.category ?? SourceCategory.MEMES,
      status: params.status ?? SourceStatus.ACTIVE,
    });
    return this.sourceRepository.save(source);
  }

  public async toggleStatus(sourceId: number): Promise<SourceChannelEntity | null> {
    const source = await this.sourceRepository.findOne({ where: { id: sourceId } });
    if (!source) return null;
    source.status = source.status === SourceStatus.DISABLED ? SourceStatus.ACTIVE : SourceStatus.DISABLED;
    return this.sourceRepository.save(source);
  }

  /**
   * Владелец взял пост источника в публикацию/очередь/кринж — фиксируем
   * интерес: растёт takenTotal и вес, снимается пауза (канал вернулся).
   */
  public async markSourceTaken(sourceChatId: string | number): Promise<void> {
    const source = await this.sourceRepository.findOne({ where: { chatId: String(sourceChatId) } });
    if (!source) return;
    source.takenTotal = (source.takenTotal ?? 0) + 1;
    source.lastTakenAt = this.clock.now();
    this.applyInterest(source);
    await this.sourceRepository.save(source);
  }

  /**
   * Владелец проигнорировал/отклонил доставленную карточку источника —
   * растёт ignoredTotal, вес падает; при просадке источник уходит в cooldown.
   */
  public async markSourceIgnored(sourceChatId: string | number, hard = true): Promise<void> {
    const source = await this.sourceRepository.findOne({ where: { chatId: String(sourceChatId) } });
    if (!source) return;
    if (hard) {
      source.ignoredTotal = (source.ignoredTotal ?? 0) + 1;
    } else {
      source.softIgnoredTotal = (source.softIgnoredTotal ?? 0) + 1;
    }
    source.lastIgnoredAt = this.clock.now();
    this.applyInterest(source);
    await this.sourceRepository.save(source);
  }

  /** Эффективная дата последнего взятия: у старых источников — дата создания. */
  private effectiveLastTakenAt(source: SourceChannelEntity): Date | null {
    if (source.lastTakenAt) return source.lastTakenAt;
    return (source.takenTotal ?? 0) > 0 ? source.createdAt : null;
  }

  /** Пересчитывает вес и cooldown по накопленному интересу (с гистерезисом). */
  private applyInterest(source: SourceChannelEntity): void {
    const now = this.clock.now();
    const state = computeSourceInterest(
      {
        takenTotal: source.takenTotal ?? 0,
        ignoredTotal: source.ignoredTotal ?? 0,
        softIgnoredTotal: source.softIgnoredTotal ?? 0,
        lastIgnoredAt: source.lastIgnoredAt,
        lastTakenAt: this.effectiveLastTakenAt(source),
      },
      now
    );
    source.weight = state.weight;

    if (state.cooldownUntil) {
      if (!source.cooldownUntil) source.cooldownCount = (source.cooldownCount ?? 0) + 1;
      // Каждая следующая пауза длиннее — без «качелей».
      const extraDays = COOLDOWN_DAYS * 0.5 * Math.max(0, (source.cooldownCount ?? 1) - 1);
      source.cooldownUntil = new Date(state.cooldownUntil.getTime() + extraDays * 86_400_000);
    } else {
      source.cooldownUntil = null;
    }
  }

  /**
   * Остывание положительного рейтинга: если канал не брали TAKEN_STALE_DAYS,
   * его история взятий делится пополам; затем вес пересчитывается с учётом
   * давности последнего взятия (буст тает, а не держится вечно).
   */
  public async refreshInterest(): Promise<number> {
    const now = this.clock.now();
    const staleMs = TAKEN_STALE_DAYS * 86_400_000;
    const sources = await this.sourceRepository.find({ where: { excluded: false } });
    let cooled = 0;
    for (const source of sources) {
      const beforeTaken = source.takenTotal ?? 0;
      const beforeWeight = source.weight ?? 1;

      // Делим историю не чаще раза в TAKEN_STALE_DAYS и только при простое.
      const anchor = (source.lastTakenAt ?? source.createdAt).getTime();
      const cooledAnchor = (source.lastTakenCooledAt ?? source.createdAt).getTime();
      if (
        beforeTaken > 0 &&
        now.getTime() - anchor >= staleMs &&
        now.getTime() - cooledAnchor >= staleMs
      ) {
        source.takenTotal = Math.floor(beforeTaken / 2);
        source.lastTakenCooledAt = now;
        cooled += 1;
      }

      // Вес пересчитываем без побочек для cooldown (его ведёт refreshCooldowns).
      const state = computeSourceInterest(
        {
          takenTotal: source.takenTotal ?? 0,
          ignoredTotal: source.ignoredTotal ?? 0,
          softIgnoredTotal: source.softIgnoredTotal ?? 0,
          lastIgnoredAt: source.lastIgnoredAt,
          lastTakenAt: this.effectiveLastTakenAt(source),
        },
        now
      );
      source.weight = state.weight;

      if (source.takenTotal !== beforeTaken || source.weight !== beforeWeight) {
        await this.sourceRepository.save(source);
      }
    }
    if (cooled) this.logger.log(`Parser: остыло (прощено взятий) источников: ${cooled}`);
    return cooled;
  }

  public async refreshCooldowns(): Promise<number> {
    const now = this.clock.now();
    const sources = await this.sourceRepository.find({
      where: { excluded: false },
    });
    let released = 0;
    for (const source of sources) {
      if (!source.cooldownUntil || source.cooldownUntil.getTime() > now.getTime()) continue;
      // Половину штрафа прощаем и НЕ уходим в паузу заново (иначе «качели»).
      source.ignoredTotal = Math.floor((source.ignoredTotal ?? 0) / 2);
      source.softIgnoredTotal = Math.floor((source.softIgnoredTotal ?? 0) / 2);
      source.cooldownUntil = null;
      source.lastIgnoredAt = null;
      const state = computeSourceInterest(
        {
          takenTotal: source.takenTotal ?? 0,
          ignoredTotal: source.ignoredTotal,
          softIgnoredTotal: source.softIgnoredTotal,
          lastIgnoredAt: null,
          lastTakenAt: this.effectiveLastTakenAt(source),
        },
        now
      );
      source.weight = state.weight;
      await this.sourceRepository.save(source);
      released += 1;
      this.logger.log(`Parser: источник ${source.title ?? source.chatId} вернулся из паузы`);
    }
    return released;
  }

  /** Жёсткое исключение источника (чёрный список) с подтверждением в UI. */
  public async excludeSource(sourceId: number): Promise<SourceChannelEntity | null> {
    const source = await this.sourceRepository.findOne({ where: { id: sourceId } });
    if (!source) return null;
    source.excluded = true;
    source.excludedAt = this.clock.now();
    source.status = SourceStatus.DISABLED;
    source.lastError = 'excluded-by-owner';
    await this.sourceRepository.save(source);
    this.logger.log(`Parser: источник ${source.title ?? source.chatId} исключён владельцем`);
    return source;
  }

  /** Возврат источника из чёрного списка. */
  public async restoreSource(sourceId: number): Promise<SourceChannelEntity | null> {
    const source = await this.sourceRepository.findOne({ where: { id: sourceId } });
    if (!source) return null;
    source.excluded = false;
    source.excludedAt = null;
    source.ignoredTotal = 0;
    source.softIgnoredTotal = 0;
    source.cooldownCount = 0;
    source.lastIgnoredAt = null;
    source.cooldownUntil = null;
    source.status = source.username || source.rawChatId ? SourceStatus.ACTIVE : SourceStatus.WEB_ONLY;
    source.lastError = null;
    this.applyInterest(source);
    if (source.weight < 1) source.weight = 1;
    await this.sourceRepository.save(source);
    this.logger.log(`Parser: источник ${source.title ?? source.chatId} возвращён из чёрного списка`);
    return source;
  }

  public async setCategory(sourceId: number, category: SourceCategory): Promise<SourceChannelEntity | null> {
    const source = await this.sourceRepository.findOne({ where: { id: sourceId } });
    if (!source) return null;
    source.category = category;
    return this.sourceRepository.save(source);
  }

  /**
   * Пересчитывает базлайн источника из собранных постов и (раз в сутки)
   * обновляет подписчики/ERR через channels.getFullChannel.
   */
  public async refreshSourceStats(
    source: SourceChannelEntity,
    client: TelegramClient
  ): Promise<SourceChannelEntity | null> {
    const now = this.clock.now();
    const stale = !source.statsUpdatedAt || now.getTime() - source.statsUpdatedAt.getTime() > 86_400_000;

    const baseline = await this.computeBaselineFor(source);
    if (baseline) {
      source.baseline = baseline;
    }

    if (stale) {
      const peer = source.username ?? bigInt(source.chatId); // marked id
      if (peer != null) {
        const full = await this.guard.run('getFullChannel', () =>
          client.invoke(new Api.channels.GetFullChannel({ channel: peer as never }))
        );
        const participants = Number((full as { fullChat?: { participantsCount?: number } })?.fullChat
          ?.participantsCount ?? 0);
        if (participants > 0) {
          source.subscribers = participants;
          source.err = baseline && participants > 0 ? baseline.vmed / participants : source.err;
        }
      }
      source.statsUpdatedAt = now;
    }

    return this.sourceRepository.save(source);
  }

  /**
   * Первичный базлайн из истории канала (getHistory): нужен, когда
   * базлайн ещё не накопился из оценённых кандидатов — иначе оценки
   * никогда не стартуют (круг: baseline ← metrics ← evaluation ← baseline).
   */
  public async seedBaselineFromHistory(
    source: SourceChannelEntity,
    client: TelegramClient
  ): Promise<ChannelBaseline | null> {
    if (!source.rawChatId && !source.username) return null;
    const peer = bigInt(source.chatId); // marked id (-100...)
    // Новый источник смотрим не глубже SCAN_WINDOW_HOURS.
    const since = Math.floor((this.clock.now().getTime() - SCAN_WINDOW_HOURS * 3_600_000) / 1000);

    const messages = await this.guard.run<TotalList<Api.Message>>('getHistory:seed', () =>
      client.getMessages(peer, { limit: 100, offsetDate: since })
    );
    if (!messages?.length) return null;

    const posts = messages
      .filter((message) => message && this.hasMedia(message) && Number(message.views ?? 0) > 0)
      .slice(0, 30)
      .map((message) => ({
        views: Number(message.views ?? 0),
        reactions: (message.reactions?.results ?? []).reduce(
          (sum, item) => sum + Number(item.count ?? 0),
          0
        ),
        posShare: this.posShareOf(message),
      }));
    if (posts.length < 5) return null;

    const baseline = computeBaseline(posts, this.clock.now());
    source.baseline = baseline;
    source.statsUpdatedAt = this.clock.now();
    await this.sourceRepository.save(source);
    this.logger.log(`Parser: seeded baseline для ${source.title ?? source.chatId} (n=${posts.length})`);
    return baseline;
  }

  private hasMedia(message: Api.Message): boolean {
    return Boolean(message.photo || message.video);
  }

  private posShareOf(message: Api.Message): number {
    const results = message.reactions?.results ?? [];
    let total = 0;
    let positive = 0;
    for (const item of results) {
      const count = Number(item.count ?? 0);
      total += count;
      if (POSITIVE_REACTIONS.includes((item.reaction as { emoticon?: string })?.emoticon ?? '')) {
        positive += count;
      }
    }
    return total > 0 ? positive / total : 0;
  }

  /** Базлайн по последним собранным постам источника (с просмотрами). */
  public async computeBaselineFor(source: SourceChannelEntity): Promise<StoredBaseline | null> {
    const rows = await this.observedRepository.find({
      where: {
        sourceChatId: source.chatId,
        views: MoreThan(0),
        evaluatedAt: LessThan(this.clock.now()),
      },
      order: { sourceMessageId: 'DESC' },
      take: 50,
    });
    const usable = rows;
    if (usable.length < 5) return null;

    const baseline = computeBaseline(
      usable.map((row) => ({
        views: Number(row.views ?? 0),
        reactions: row.reactions ?? 0,
        posShare: row.metrics?.posShare ?? 0,
      }))
    );
    // Сохраняем, чтобы базлайн был виден в админке и не считался заново.
    source.baseline = baseline;
    await this.sourceRepository.save(source);
    return baseline;
  }

  public isOwnChannel(chatId: number): boolean {
    const own = [
      this.config.memeChanelId,
      this.config.cringeMemeChannelId,
      this.config.bestMemeChanelId,
      this.config.userRequestMemeChannel,
    ];
    return own.includes(chatId);
  }
}
