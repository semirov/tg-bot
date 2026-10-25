/**
 * Канонический ключ пира для состояния парсера (бэкофф, «мёртвый» пир).
 *
 * Один и тот же канал приходит в разных формах: `rawChatId` (8888888888),
 * marked id (-1008888888888), username (SomeChannel). Ключ должен совпадать,
 * иначе одна мёртвая сущность живёт в состоянии трижды, а свип обходит её
 * только по одной из форм.
 *
 * Числа приводятся к marked id канала (`-100<raw>`), строки — к username
 * в нижнем регистре без `@`. Нечисловые пиры (юзеры) в парсере не встречаются.
 */
export function canonicalPeerKey(peer: string | number): string {
  const key = String(peer).trim();
  if (!/^-?\d+$/.test(key)) return key.replace(/^@/, '').toLowerCase();
  return key.startsWith('-100') ? key : `-100${key.replace(/^-/, '')}`;
}

/**
 * Ключи кэша gramjs для пира: marked id и «сырой» id (entity cache хранит
 * обе формы), для username — сам username.
 */
export function peerCacheKeys(peer: string | number): string[] {
  const marked = canonicalPeerKey(peer);
  if (!/^-?\d+$/.test(marked)) return [marked];
  const raw = marked.replace(/^-100/, '');
  return [marked, raw, `-${raw}`].filter(
    (value, index, all) => all.indexOf(value) === index
  );
}

/** Подпись пира для лога: числа — как есть, username наружу не пишем. */
export function peerLabel(peer: string | number | undefined | null): string {
  if (peer == null) return '-';
  const key = String(peer);
  return /^-?\d+$/.test(key) ? key : '<username>';
}
