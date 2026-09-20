import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Inject } from '@nestjs/common';
import { Repository } from 'typeorm';
import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { CLOCK, Clock } from '../../../shared/clock';
import { SourceCandidateEntity } from '../entities/source-candidate.entity';
import { SourceChannelEntity } from '../entities/source-channel.entity';
import {
  CandidateOrigin,
  CandidateVerdict,
  DISCOVERY_CROSS_LIMIT_PER_RUN,
  DISCOVERY_WEB_CHECK_PER_RUN,
  SourceCategory,
  SourceStatus,
} from '../constants/parser.constants';
import { ParserClientService } from './parser-client.service';
import { ParserMtprotoGuard } from './parser-mtproto-guard.service';
import { ParserRegistryService } from './parser-registry.service';
import { ParserSettingsService } from './parser-settings.service';
import { ParserAiService } from './parser-ai.service';
import { CrossLinkHit, normalizeChatId } from '../domain/parser-cross-links';
import { estimatePostsPerDay, fetchTmePreview } from '../domain/tme-preview';
import { median } from '../domain/parser-scoring';

/**
 * Discovery: собирает кросс-ссылки из собранных постов (forward-источники и
 * t.me-ссылки), проверяет кандидатов через web-preview t.me/s/ и
 * channels.getFullChannel, классифицирует темой (AI) и ведёт очередь
 * подтверждения в админ-меню.
 */
@Injectable()
export class ParserDiscoveryService {
  private readonly logger = new Logger(ParserDiscoveryService.name);

  constructor(
    @InjectRepository(SourceCandidateEntity)
    private readonly candidateRepository: Repository<SourceCandidateEntity>,
    @InjectRepository(SourceChannelEntity)
    private readonly sourceRepository: Repository<SourceChannelEntity>,
    private readonly parserClient: ParserClientService,
    private readonly guard: ParserMtprotoGuard,
    private readonly registry: ParserRegistryService,
    private readonly settings: ParserSettingsService,
    private readonly ai: ParserAiService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  public get repository(): Repository<SourceCandidateEntity> {
    return this.candidateRepository;
  }

  /** Коллектор отдаёт кросс-ссылки постов: поднимаем счётчики кандидатов. */
  public async registerCrossLinks(hits: ReadonlyArray<CrossLinkHit>): Promise<void> {
    let created = 0;
    for (const hit of hits) {
      const key = hit.username ? `u:${hit.username}` : hit.chatId ? `c:${hit.chatId}` : null;
      if (!key) continue;

      const registered = await this.findRegistered(key, hit);
      if (registered) continue;

      const existing = await this.candidateRepository.findOne({ where: { key } });
      if (existing) {
        existing.mentions += 1;
        await this.candidateRepository.save(existing);
        continue;
      }

      await this.candidateRepository.save(
        this.candidateRepository.create({
          key,
          username: hit.username ?? null,
          chatId: hit.chatId != null ? String(hit.chatId) : null,
          origin: hit.origin === 'fwd' ? CandidateOrigin.CROSS_FWD : CandidateOrigin.CROSS_LINK,
          mentions: 1,
          verdict: CandidateVerdict.PENDING,
        })
      );
      created += 1;
    }

    if (created > DISCOVERY_CROSS_LIMIT_PER_RUN) {
      this.logger.debug(`Parser discovery: новых кандидатов ${created}`);
    }
  }

  /** Прогон discovery (cron): web-check пачки кандидатов. */
  public async runWebCheck(): Promise<number> {
    const pending = await this.candidateRepository.find({
      where: { verdict: CandidateVerdict.PENDING },
      order: { mentions: 'DESC', id: 'ASC' },
      take: DISCOVERY_WEB_CHECK_PER_RUN,
    });
    if (!pending.length) return 0;

    let checked = 0;
    for (const candidate of pending) {
      try {
        await this.checkCandidate(candidate);
        checked += 1;
      } catch (error) {
        this.logger.warn(`Parser discovery: web-check ${candidate.key} ошибка: ${error}`);
      }
      await this.guard.pace(2000);
    }
    return checked;
  }

  /** Кап повторных web-check: дальше — REJECTED checks-exhausted. */
  private static readonly MAX_CHECK_ATTEMPTS = 5;

  /** Полная проверка кандидата: username → web-preview → подписчики → AI → гейт. */
  public async checkCandidate(candidate: SourceCandidateEntity): Promise<SourceCandidateEntity> {
    const config = this.settings.current;

    if (!candidate.username) {
      const username = await this.resolveUsername(candidate);
      if (!username) {
        candidate.reason = 'username-unresolved';
        await this.candidateRepository.save(candidate);
        return candidate;
      }
      candidate.username = username;
    }

    const preview = await fetchTmePreview(candidate.username);
    if (!preview || !preview.posts.length) {
      candidate.reason = 'web-preview-empty';
      candidate.checkedAt = this.clock.now();
      await this.candidateRepository.save(candidate);
      return candidate;
    }
    candidate.title = preview.title;

    const username = candidate.username;
    if (!username) {
      candidate.reason = 'username-unresolved';
      await this.candidateRepository.save(candidate);
      return candidate;
    }
    const full = await this.guard.run('getFullChannel', () => this.invokeGetFullChannel(username));
    // Инфраструктурная неудача — не вердикт: остаём в PENDING до следующего прогона
    // (с капом повторных проверок).
    if (full == null) {
      candidate.attempts += 1;
      candidate.reason = 'subscriber-check-failed';
      if (candidate.attempts >= ParserDiscoveryService.MAX_CHECK_ATTEMPTS) {
        candidate.verdict = CandidateVerdict.REJECTED;
        candidate.reason = 'checks-exhausted';
      }
      candidate.checkedAt = this.clock.now();
      await this.candidateRepository.save(candidate);
      return candidate;
    }
    const subscribers = Number(
      (full as { fullChat?: { participantsCount?: number } })?.fullChat?.participantsCount ?? 0
    );
    if (subscribers > 0) candidate.subscribers = subscribers;

    const views = preview.posts.map((post) => post.views).filter((views) => views > 0);
    const vmed = median(views);
    candidate.postsPerDay = estimatePostsPerDay(preview.posts);
    candidate.errEstimate = subscribers > 0 ? vmed / subscribers : null;

    if (config.aiEnabled) {
      const verdict = await this.ai.classifyChannel(
        preview.title,
        preview.posts.map((post) => post.text).filter((text) => text.length > 0)
      );
      candidate.aiVerdict = verdict;
    }

    const gate = this.evaluateGate(candidate, config.errMin, config.aiRelevanceMin, config.aiEnabled);
    candidate.attempts += 1;
    candidate.checkedAt = this.clock.now();

    if (gate.passed) {
      candidate.verdict = CandidateVerdict.READY;
      candidate.reason = undefined;
    } else if (this.isInfraReason(gate.reason)) {
      // Инфраструктурные причины не вердикт: ждём следующего прогона, но с капом.
      candidate.verdict = CandidateVerdict.PENDING;
      candidate.reason = gate.reason;
      if (candidate.attempts >= ParserDiscoveryService.MAX_CHECK_ATTEMPTS) {
        candidate.verdict = CandidateVerdict.REJECTED;
        candidate.reason = 'checks-exhausted';
      }
    } else {
      candidate.verdict = CandidateVerdict.REJECTED;
      candidate.reason = gate.reason;
    }

    await this.candidateRepository.save(candidate);

    this.logger.log(
      `Parser discovery: кандидат ${candidate.key} → ${candidate.verdict} (${gate.reason ?? 'ok'})`
    );
    return candidate;
  }

  /** Подтверждение кандидата владельцем: web-only (публичные) или джойн. */
  public async approve(
    candidateId: number,
    mode: 'web_only' | 'join',
    category: 'memes' | 'cringe' = 'memes'
  ): Promise<SourceCandidateEntity | null> {
    const candidate = await this.candidateRepository.findOne({ where: { id: candidateId } });
    if (!candidate) return null;
    // Только проверенные кандидаты: старые/отклонённые карточки не джойнятся.
    if (candidate.verdict !== CandidateVerdict.READY) {
      candidate.reason = `approve-blocked:${candidate.verdict}`;
      await this.candidateRepository.save(candidate);
      return null;
    }
    if (!candidate.username) {
      await this.checkCandidate(candidate);
      if (!candidate.username) return null;
    }

    if (mode === 'join') {
      if (!this.joinAllowed()) {
        candidate.reason = 'join-daily-cap';
        await this.candidateRepository.save(candidate);
        return null;
      }
      const joined = await this.joinChannel(candidate.username);
      if (!joined) {
        candidate.reason = 'join-failed';
        await this.candidateRepository.save(candidate);
        return null;
      }
      this.joinCounters = this.joinCounters.filter((day) => day === this.dayKey());
      this.joinCounters.push(this.dayKey());
    }

    const client = this.parserClient.client();
    let rawChatId: number | null = candidate.chatId ? Number(candidate.chatId) : null;
    if (rawChatId == null && client) {
      const entity = await this.guard.run('getEntity', () => client.getEntity(candidate.username as string));
      const channelId = (entity as { id?: { toString(): string } })?.id;
      rawChatId = channelId ? normalizeChatId(Number(channelId.toString())) : null;
    }
    if (rawChatId == null) {
      candidate.reason = 'chatId-unresolved';
      await this.candidateRepository.save(candidate);
      return null;
    }

    const created = await this.registry.addSource({
      chatId: rawChatId,
      rawChatId,
      username: candidate.username,
      title: candidate.title,
      status: mode === 'join' ? SourceStatus.ACTIVE : SourceStatus.WEB_ONLY,
      category: category as SourceCategory,
    });

    candidate.verdict = CandidateVerdict.APPROVED;
    candidate.reason = mode === 'join' ? 'joined' : 'web-only';
    await this.candidateRepository.save(candidate);

    if (created) this.logger.log(`Parser discovery: источник добавлен ${candidate.key} (${mode})`);
    return candidate;
  }

  public async reject(candidateId: number, reason = 'owner-rejected'): Promise<SourceCandidateEntity | null> {
    const candidate = await this.candidateRepository.findOne({ where: { id: candidateId } });
    if (!candidate) return null;
    candidate.verdict = CandidateVerdict.REJECTED;
    candidate.reason = reason;
    await this.candidateRepository.save(candidate);
    return candidate;
  }

  /** Публичные кандидаты для карточек в админ-меню. */
  public listReady(limit = 10): Promise<SourceCandidateEntity[]> {
    return this.candidateRepository.find({
      where: { verdict: CandidateVerdict.READY },
      order: { mentions: 'DESC' },
      take: limit,
    });
  }

  private evaluateGate(
    candidate: SourceCandidateEntity,
    errMin: number,
    aiRelevanceMin: number,
    aiEnabled: boolean
  ): { passed: boolean; reason?: string } {
    if ((candidate.errEstimate ?? 0) < errMin) {
      return { passed: false, reason: `err<${errMin}` };
    }
    if (candidate.postsPerDay != null && (candidate.postsPerDay < 1 || candidate.postsPerDay > 60)) {
      return { passed: false, reason: `postsPerDay=${candidate.postsPerDay.toFixed(1)}` };
    }
    if (aiEnabled && candidate.aiVerdict) {
      if (candidate.aiVerdict.nsfw) return { passed: false, reason: 'ai:nsfw' };
      if (candidate.aiVerdict.relevance < aiRelevanceMin) {
        return { passed: false, reason: `ai:relevance<${aiRelevanceMin}` };
      }
    }
    return { passed: true };
  }

  private dayKey(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }

  private joinCounters: string[] = [];

  /** Анти-бан: не больше 2 джойнов в сутки. */
  private joinAllowed(): boolean {
    this.joinCounters = this.joinCounters.filter((day) => day === this.dayKey());
    return this.joinCounters.length < 2;
  }

  private isInfraReason(reason?: string): boolean {
    return (
      reason === 'subscriber-check-failed' ||
      reason === 'web-preview-empty' ||
      reason === 'username-unresolved'
    );
  }

  private async invokeGetFullChannel(username: string): Promise<unknown> {
    const client = this.parserClient.client();
    if (!client) return null;
    return client.invoke(new Api.channels.GetFullChannel({ channel: username }));
  }

  private async resolveUsername(candidate: SourceCandidateEntity): Promise<string | null> {
    if (candidate.username) return candidate.username;
    if (candidate.chatId == null) return null;
    const client = this.parserClient.client();
    if (!client) return null;
    const entity = await this.guard.run('getEntity', () => client.getEntity(bigInt(candidate.chatId)));
    const username = (entity as { username?: string })?.username;
    return username ?? null;
  }

  private async joinChannel(username: string): Promise<boolean> {
    const client = this.parserClient.client();
    if (!client) return false;
    const result = await this.guard.run('joinChannel', () =>
      client.invoke(new Api.channels.JoinChannel({ channel: username }))
    );
    return result != null;
  }

  private async findRegistered(
    key: string,
    hit: CrossLinkHit
  ): Promise<SourceChannelEntity | undefined> {
    if (hit.username) {
      const byUsername = await this.sourceRepository.findOne({
        where: { username: hit.username },
      });
      if (byUsername) return byUsername;
    }
    if (hit.chatId != null) {
      const byChatId = await this.sourceRepository.findOne({
        where: { chatId: String(hit.chatId) },
      });
      if (byChatId) return byChatId;
    }
    void key;
    return undefined;
  }
}
