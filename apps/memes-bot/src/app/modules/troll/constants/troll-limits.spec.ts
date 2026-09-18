import {
  TROLL_CONTEXT_MAX_CHARS,
  TROLL_CONTEXT_MAX_TURNS,
  TROLL_DEFECT_SEVERITIES,
  TROLL_DIAGNOSTIC_MAX_TOKENS,
  TROLL_DIAGNOSTIC_MODEL,
  TROLL_HARD_MAX_INPUT_CHARS,
  TROLL_HARD_MAX_TOKENS,
  TROLL_LLM_MAX_RETRIES,
  TROLL_LLM_RETRY_DELAY_MS,
  TROLL_LLM_TIMEOUT_MS,
  TROLL_MAX_CONCURRENT_REQUESTS,
  TROLL_MIRROR_MIN_WORD_LEN,
  TROLL_SELF_CHECK_MAX_ATTEMPTS,
  TROLL_SETTINGS_ID,
} from './troll-limits';

describe('troll-limits', () => {
  it('держит жёсткие потолки безопасности LLM', () => {
    expect(TROLL_HARD_MAX_TOKENS).toBe(1200);
    expect(TROLL_HARD_MAX_INPUT_CHARS).toBe(3000);
    expect(TROLL_MAX_CONCURRENT_REQUESTS).toBe(4);
    expect(TROLL_LLM_TIMEOUT_MS).toBe(45000);
    expect(TROLL_LLM_MAX_RETRIES).toBe(1);
    expect(TROLL_LLM_RETRY_DELAY_MS).toBeGreaterThan(0);
  });

  it('задаёт синглтон настроек и аварийные потолки контекста', () => {
    expect(TROLL_SETTINGS_ID).toBe(1);
    expect(TROLL_CONTEXT_MAX_TURNS).toBeGreaterThan(0);
    expect(TROLL_CONTEXT_MAX_CHARS).toBe(200000);
  });

  it('описывает диагностику дефекта', () => {
    expect(TROLL_DIAGNOSTIC_MODEL).toBe('deepseek-v4-pro');
    expect(TROLL_DIAGNOSTIC_MAX_TOKENS).toBe(900);
    expect(TROLL_DEFECT_SEVERITIES).toEqual(['low', 'medium', 'high']);
  });

  it('ограничивает самопроверку и кривляние', () => {
    expect(TROLL_SELF_CHECK_MAX_ATTEMPTS).toBe(3);
    expect(TROLL_MIRROR_MIN_WORD_LEN).toBe(4);
  });
});
