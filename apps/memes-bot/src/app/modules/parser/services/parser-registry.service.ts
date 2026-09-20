import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Inject } from '@nestjs/common';
import { LessThan, MoreThan, Repository } from 'typeorm';
import * as bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { TotalList } from 'telegram/Helpers';
import { CLOCK, Clock } from '../../../shared/clock';
import { BaseConfigService } from '../../config/base-config.service';
import { SourceCategory, SourceStatus } from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity, StoredBaseline } from '../entities/source-channel.entity';
import { computeBaseline, ChannelBaseline } from '../domain/parser-scoring';
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

  /** Активные и web-only источники (по ним идёт сбор). */
  public listCollectible(): Promise<SourceChannelEntity[]> {
    return this.sourceRepository.find({
      where: [{ status: SourceStatus.ACTIVE }, { status: SourceStatus.WEB_ONLY }],
    });
  }

  public listAll(): Promise<SourceChannelEntity[]> {
    return this.sourceRepository.find({ order: { id: 'ASC' } });
  }

  public async countCollectible(): Promise<number> {
    return this.sourceRepository.count({
      where: [{ status: SourceStatus.ACTIVE }, { status: SourceStatus.WEB_ONLY }],
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
    if (exists) return exists;

    const collectible = await this.countCollectible();
    const budget = Math.max(1, this.settings.current.maxSources);
    if (collectible >= budget) {
      this.logger.warn(`Parser: реестр источников переполнен (>=${budget}), добавление отклонено`);
      return null;
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

    const messages = await this.guard.run<TotalList<Api.Message>>('getHistory:seed', () =>
      client.getMessages(peer, { limit: 50 })
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

  /**
   * Прунинг: источники без единого отобранного поста за окно и с накопленными
   * отклонениями помечаются для решения владельца (переводятся в disabled).
   */
  public async pruneWeakSources(windowDays = 14): Promise<number> {
    const threshold = new Date(this.clock.now().getTime() - windowDays * 86_400_000);
    const sources = await this.listCollectible();
    let disabled = 0;

    for (const source of sources) {
      if (source.createdAt.getTime() > threshold.getTime()) continue;
      const since = new Date(threshold);
      const recent = await this.observedRepository.find({
        where: { sourceChatId: source.chatId, createdAt: MoreThan(since) },
        take: 100,
      });
      if (!recent.length) continue;
      const hasSelected = recent.some(
        (row) => row.status === 'delivered' || row.status === 'published' || row.status === 'queued'
      );
      if (hasSelected) continue;
      const rejected = recent.filter((row) => row.status === 'rejected').length;
      if (rejected < recent.length * 0.9) continue;

      source.status = SourceStatus.DISABLED;
      source.lastError = 'auto-pruned: нет отобранных постов за окно';
      await this.sourceRepository.save(source);
      disabled += 1;
      this.logger.log(`Parser: источник ${source.title ?? source.chatId} авто-отключён (прунинг)`);
    }

    return disabled;
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
