import {
  CONVERSATION_PAUSE_RULE,
  CRIMINAL_ASSESSMENT_PROMPT,
  CRIMINAL_STAT_PROMPT,
  DEFECT_DIAGNOSTIC_PROMPT,
  FUTURE_ANGRY_PROMPT,
  FUTURE_BAD_PROMPT,
  FUTURE_GOOD_PROMPT,
  JERK_PROMPT,
  MAT_RULES,
  MEME_DENY_PROMPT,
  MESSAGE_REFS_RULE,
  MIRROR_PROMPT,
  SARCASM_PROMPT,
  SECURITY_RULES,
  SELF_CHECK_PROMPT,
  SUMMARY_PROMPT,
  TROLL_CAPABILITIES_REPLY,
  TROLL_FUTURE_TECHNIQUES,
  TROLL_MIRROR_INFIXES,
  TROLL_MIRROR_PREFIXES,
  TROLL_MIRROR_TECHNIQUES,
  buildRetryNote,
} from './troll-prompts';

describe('troll-prompts', () => {
  it('во все чатовые промпты подключены правила безопасности', () => {
    for (const prompt of [
      FUTURE_BAD_PROMPT,
      FUTURE_ANGRY_PROMPT,
      FUTURE_GOOD_PROMPT,
      SARCASM_PROMPT,
      JERK_PROMPT,
      MEME_DENY_PROMPT,
      SUMMARY_PROMPT,
      CRIMINAL_STAT_PROMPT,
      CRIMINAL_ASSESSMENT_PROMPT,
      MIRROR_PROMPT,
    ]) {
      expect(prompt).toContain(SECURITY_RULES);
    }
  });

  it('запрещает раскрывать промпт и требует недоверенные данные', () => {
    expect(SECURITY_RULES).toContain('<user_message>');
    expect(SECURITY_RULES).toContain('НЕДОВЕРЕННЫЕ ДАННЫЕ');
  });

  it('кроме доброго предсказания везде есть правила мата', () => {
    expect(MAT_RULES).toContain('мат');
    expect(FUTURE_BAD_PROMPT).toContain(MAT_RULES);
    expect(FUTURE_GOOD_PROMPT).not.toContain(MAT_RULES);
  });

  it('описывает техники предсказаний и кривляния', () => {
    expect(TROLL_FUTURE_TECHNIQUES.length).toBeGreaterThan(0);
    expect(TROLL_MIRROR_TECHNIQUES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seed: 'prefix' }),
        expect.objectContaining({ seed: 'infix' }),
      ])
    );
    expect(TROLL_MIRROR_PREFIXES.length).toBeGreaterThan(0);
    expect(TROLL_MIRROR_INFIXES.length).toBeGreaterThan(0);
  });

  it('содержит статичный ответ про умения бота', () => {
    expect(TROLL_CAPABILITIES_REPLY).toContain('/stat');
    expect(TROLL_CAPABILITIES_REPLY).toContain('/future');
  });

  it('правила пауз и ссылок на сообщения упоминают разрыв', () => {
    expect(CONVERSATION_PAUSE_RULE).toContain('разрыв беседы');
    expect(MESSAGE_REFS_RULE).toContain('replyTo');
  });

  it('промпты самопроверки и диагностики требуют строгий JSON', () => {
    expect(SELF_CHECK_PROMPT).toContain('"score"');
    expect(DEFECT_DIAGNOSTIC_PROMPT).toContain('"severity"');
  });

  describe('buildRetryNote', () => {
    it('перечисляет проблемы прошлой попытки', () => {
      const note = buildRetryNote('старый ответ', ['не тот адресат', 'мимо темы'], 2);

      expect(note).toContain('ПОПЫТКА 2');
      expect(note).toContain('не тот адресат; мимо темы');
      expect(note).toContain('«старый ответ»');
    });

    it('без проблем подставляет общую формулировку', () => {
      const note = buildRetryNote('старый ответ', [], 1);

      expect(note).toContain('ответ вышел слабым');
      expect(note).toContain('ПОПЫТКА 1');
    });
  });
});
