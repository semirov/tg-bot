import axios from 'axios';

/** Пост из web-preview t.me/s/<user>. */
export interface TmePost {
  id: number | null;
  views: number;
  hasMedia: boolean;
  text: string;
  timeIso: string | null;
}

/** Результат разбора web-preview канала. */
export interface TmePreview {
  username: string;
  title: string | null;
  posts: TmePost[];
  error?: string;
}

/** Вытаскивает «12.3K» из HTML блока просмотров. */
export function extractViewsFromBubble(bubbleHtml: string): number {
  const match = bubbleHtml.match(/tgme_widget_message_views[^>]*>\s*([0-9.,KMkm]+)\s*</);
  return match ? parseTmeViews(match[1]) : 0;
}

export function parseTmeViews(raw: string | undefined | null): number {
  if (!raw) return 0;
  const normalized = raw.trim().replace(/,/g, '.');
  const match = normalized.match(/^([\d.]+)\s*([KkMm]?)$/);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;
  const multiplier = { '': 1, k: 1_000, m: 1_000_000 }[match[2].toLowerCase()] ?? 1;
  return Math.round(value * multiplier);
}

/** Разбирает HTML web-preview: посты, просмотры, медиа, тексты. */
export function parseTmeHtml(html: string, username: string): TmePreview {
  const titleMatch = html.match(/<span class="tgme_widget_message_owner_name"[^>]*>([\s\S]*?)<\/span>/);
  const title = titleMatch ? stripTags(titleMatch[1]) : null;

  const bubbles = html.split('tgme_widget_message_wrap').slice(1);
  const posts: TmePost[] = [];

  for (const bubble of bubbles) {
    const idMatch = bubble.match(/\/(\w+)\/(\d+)/);
    const id = idMatch ? Number(idMatch[2]) : null;

    const views = extractViewsFromBubble(bubble);
    const hasMedia = /tgme_widget_message_photo|tgme_widget_message_video|tgme_widget_message_document/.test(bubble);

    const textMatch = bubble.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    const text = textMatch ? stripTags(textMatch[1]).slice(0, 500) : '';

    const timeMatch = bubble.match(/<time[^>]*datetime="([^"]+)"/);
    const timeIso = timeMatch ? timeMatch[1] : null;

    posts.push({ id, views, hasMedia, text, timeIso });
  }

  return { username, title, posts };
}

const stripTags = (html: string): string =>
  html
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** Оценка частоты постинга по временным меткам web-preview (постов/сутки). */
export function estimatePostsPerDay(posts: ReadonlyArray<TmePost>): number | null {
  const times = posts
    .map((p) => (p.timeIso ? new Date(p.timeIso).getTime() : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  const spanHours = (times[times.length - 1] - times[0]) / 3_600_000;
  if (spanHours <= 0) return null;
  return Math.round((times.length / spanHours) * 24);
}

/**
 * Загружает и разбирает web-preview публичного канала. Возвращает null при
 * ошибке сети/разборе — вызывающий код трактует это как «канал не проверен».
 */
export async function fetchTmePreview(username: string, timeoutMs = 15_000): Promise<TmePreview | null> {
  const url = `https://t.me/s/${username}`;
  try {
    const response = await axios.get<string>(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; memes-bot parser)' },
      responseType: 'text',
    });
    const html = typeof response.data === 'string' ? response.data : '';
    if (!html.includes('tgme_widget_message')) return null;
    return parseTmeHtml(html, username);
  } catch {
    return null;
  }
}
