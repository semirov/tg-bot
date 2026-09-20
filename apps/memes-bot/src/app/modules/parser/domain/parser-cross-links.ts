import { Api } from 'telegram';

/** Кросс-ссылка, найденная в посте. */
export interface CrossLinkHit {
  username: string | null;
  chatId: number | null;
  origin: 'fwd' | 'link';
}

const TG_LINK_RE =
  /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:c\/(\d+)|joinchat\/[A-Za-z0-9_-]+|\+[A-Za-z0-9_-]+|([A-Za-z0-9_]{3,64}))|tg:\/\/resolve\?domain=([A-Za-z0-9_]{3,64})/g;

/** channelId MTProto → «ботовый» chatId (-100XXXXXXXXXX). */
export function normalizeChatId(rawChannelId: number): number {
  if (rawChannelId > -1_000_000_000_000) {
    return -1_000_000_000_000 - rawChannelId;
  }
  return rawChannelId;
}

/**
 * Вытаскивает username'ы/чаты Telegram из текста поста. Invite-формы
 * (`+hash`, `joinchat`) и служебные ссылки отбрасываются.
 */
export function extractCrossLinksFromText(text: string | undefined | null): CrossLinkHit[] {
  if (!text) return [];
  const hits = new Map<string, CrossLinkHit>();
  for (const match of String(text).matchAll(TG_LINK_RE)) {
    const internal = match[1];
    const username = (match[2] ?? match[3] ?? '').toLowerCase();
    if (internal) {
      const chatId = -1_000_000_000_000 - Number(internal);
      hits.set(`c:${internal}`, { username: null, chatId, origin: 'link' });
      continue;
    }
    if (!username || username === 'joinchat') continue;
    hits.set(`u:${username}`, { username, chatId: null, origin: 'link' });
  }
  return [...hits.values()];
}

/** chatId исходного канала из forward-заголовка MTProto. */
export function fwdChatId(fwdFrom: Api.TypeMessageFwdHeader | undefined | null): number | null {
  const peer = (fwdFrom as { fromId?: Api.TypePeer } | undefined)?.fromId;
  if (!peer || !(peer instanceof Api.PeerChannel)) return null;
  return normalizeChatId(Number(peer.channelId.toString()));
}

/** Все кросс-ссылки поста: forward-источник + t.me-ссылки в тексте. */
export function collectPostCrossLinks(
  message: { message?: string; fwdFrom?: Api.TypeMessageFwdHeader | null },
  ownChatIds: ReadonlyArray<number>
): CrossLinkHit[] {
  const own = new Set(ownChatIds);
  const hits: CrossLinkHit[] = [];

  const fwdId = fwdChatId(message.fwdFrom);
  if (fwdId !== null && !own.has(fwdId)) {
    hits.push({ username: null, chatId: fwdId, origin: 'fwd' });
  }

  for (const hit of extractCrossLinksFromText(message.message)) {
    if (hit.chatId !== null && own.has(hit.chatId)) continue;
    hits.push(hit);
  }

  return hits;
}
