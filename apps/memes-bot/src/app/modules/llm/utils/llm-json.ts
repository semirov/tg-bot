/**
 * Разбор JSON-ответов LLM.
 *
 * Модель может вернуть markdown-обёртку, текст вокруг JSON или — при обрыве по
 * `max_tokens` — незакрытый объект. Штатный `JSON.parse` на таком ответе падает,
 * и вызывающий код считает, что модель ничего не вернула (в логах:
 * «Failed to parse DeepSeek JSON», а пользователю — «чёт я подвис»). Разбор
 * здесь максимально терпимый: снимаем обёртку, берём сбалансированный объект,
 * а при обрыве достраиваем закрывающие скобки.
 */
export function parseLlmJson<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) {
    return null;
  }

  const cleaned = stripCodeFence(raw).trim();
  if (!cleaned) {
    return null;
  }

  const direct = tryParse<T>(cleaned);
  if (direct !== undefined) {
    return direct;
  }

  const start = cleaned.indexOf('{');
  if (start === -1) {
    return null;
  }

  const balanced = extractBalanced(cleaned, start);
  if (balanced) {
    const parsed = tryParse<T>(balanced);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  const repaired = repairTruncated(cleaned.slice(start));
  if (repaired !== null) {
    const parsed = tryParse<T>(repaired);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return null;
}

function tryParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Снимает обёртку ```json ... ``` (модель иногда добавляет её вопреки промпту). */
function stripCodeFence(raw: string): string {
  return raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
}

/** Подстрока первого сбалансированного объекта, начиная с позиции `start`. */
function extractBalanced(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Достраивает обрезанный объект. Перебирает варианты обрезки от самого длинного
 * к короткому: закрывает незавершённую строку, отбрасывает «висящие» ключи и
 * запятые, добавляет закрывающие скобки по стеку. Возвращает первый вариант,
 * который парсится как валидный JSON, иначе null.
 */
function repairTruncated(fragment: string): string | null {
  const candidates = truncationCandidates(fragment);

  for (const candidate of candidates) {
    const closed = closeBrackets(candidate);
    if (closed !== null && tryParse(closed) !== undefined) {
      return closed;
    }
  }

  return null;
}

/**
 * Варианты «обрезки» обрезанного ответа. Порядок — от наиболее полного к
 * наиболее короткому: сначала как есть (и с закрытой строкой, если оборвалось
 * внутри строки), затем — по структурным границам значений (конец строки, числа,
 * литерала, закрывающей скобки).
 */
function truncationCandidates(fragment: string): string[] {
  const candidates: string[] = [fragment];
  const state = scan(fragment);

  if (state.inString) {
    candidates.push(`${fragment}"`);
  }

  // Границы значений, от конца к началу; хватит нескольких десятков.
  const boundaries = state.boundaries.slice(-50).reverse();
  for (const index of boundaries) {
    candidates.push(fragment.slice(0, index));
  }

  return candidates;
}

interface ScanResult {
  inString: boolean;
  /** Индексы сразу после завершённого значения (строка/число/литерал/скобка). */
  boundaries: number[];
}

/** Проход по тексту с учётом строк и экранирования. */
function scan(text: string): ScanResult {
  const boundaries: number[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
        boundaries.push(i + 1);
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '}' || ch === ']') {
      boundaries.push(i + 1);
    } else if (/[0-9a-z]/i.test(ch)) {
      const next = text[i + 1];
      if (next === undefined || !/[0-9a-z.+-]/i.test(next)) {
        boundaries.push(i + 1);
      }
    }
  }

  return { inString, boundaries };
}

/**
 * Добавляет закрывающие скобки по стеку. Возвращает null, если текст обрывается
 * внутри строки или на «висящем» ключе (`"key":`) — такие хвосты закрыть нельзя.
 */
function closeBrackets(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    }
  }

  if (inString) {
    return null;
  }

  const body = text.replace(/[\s,]+$/, '');
  if (body.endsWith(':')) {
    return null;
  }

  const closers = stack
    .slice()
    .reverse()
    .map((open) => (open === '{' ? '}' : ']'))
    .join('');

  return body + closers;
}
