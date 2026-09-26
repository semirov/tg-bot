import { AdminSettingsPresets } from './admin-settings-presets';

describe('AdminSettingsPresets', () => {
  it('хранит пресеты настроек тролля без изменений', () => {
    expect(AdminSettingsPresets.CRIMINAL_THRESHOLD).toEqual([0.3, 0.4, 0.5, 0.6, 0.7]);
    expect(AdminSettingsPresets.CRIMINAL_HIGH_THRESHOLD).toEqual([0.7, 0.8, 0.9]);
    expect(AdminSettingsPresets.ANALYZE_COOLDOWN_SEC).toEqual([0, 5, 10, 15, 30, 60]);
    expect(AdminSettingsPresets.SARCASM_CHANCE).toEqual([0.01, 0.03, 0.05, 0.1, 0.15, 0.2]);
    expect(AdminSettingsPresets.SARCASM_COOLDOWN_SEC).toEqual([0, 60, 300, 600, 1800, 3600]);
    expect(AdminSettingsPresets.MIRROR_CHANCE).toEqual([0.01, 0.03, 0.05, 0.1, 0.15, 0.2]);
    expect(AdminSettingsPresets.MIRROR_COOLDOWN_SEC).toEqual([0, 60, 300, 600, 1800, 3600]);
    expect(AdminSettingsPresets.REACTION_CHANCE).toEqual([0.01, 0.03, 0.05, 0.1, 0.15, 0.2]);
    expect(AdminSettingsPresets.REACTION_COOLDOWN_SEC).toEqual([0, 60, 300, 600, 1800, 3600]);
    expect(AdminSettingsPresets.JERK_WINDOW_SEC).toEqual([0, 10, 15, 30, 60, 120]);
    expect(AdminSettingsPresets.JERK_COOLDOWN_SEC).toEqual([0, 30, 60, 120, 180, 300, 600]);
    expect(AdminSettingsPresets.DIALOG_PAUSE_MIN).toEqual([5, 10, 15, 30, 60, 120, 360]);
    expect(AdminSettingsPresets.SELF_CHECK_THRESHOLD).toEqual([0.4, 0.5, 0.6, 0.7, 0.8]);
    expect(AdminSettingsPresets.MEME_ANNOUNCE_CHANCE).toEqual([0.05, 0.1, 0.2, 0.3, 0.5]);
    expect(AdminSettingsPresets.DAILY_REQUEST_LIMIT).toEqual([
      100, 200, 500, 1000, 2000, 4000, 5000, 10000,
    ]);
    expect(AdminSettingsPresets.MAX_INPUT_CHARS).toEqual([500, 800, 1000, 1500, 2000, 3000]);
  });

  describe('cycle', () => {
    it('для точного совпадения берёт следующий пресет', () => {
      expect(AdminSettingsPresets.cycle(0.3, AdminSettingsPresets.CRIMINAL_THRESHOLD)).toBe(0.4);
      expect(AdminSettingsPresets.cycle(0.6, AdminSettingsPresets.CRIMINAL_THRESHOLD)).toBe(0.7);
    });

    it('на последнем пресете переходит к первому', () => {
      expect(AdminSettingsPresets.cycle(0.7, AdminSettingsPresets.CRIMINAL_THRESHOLD)).toBe(0.3);
    });

    it('для значения вне пресетов берёт ближайший и следующий за ним', () => {
      // 0.42 не совпадает с пресетами, ближайший — 0.4, следующий — 0.5
      expect(AdminSettingsPresets.cycle(0.42, AdminSettingsPresets.CRIMINAL_THRESHOLD)).toBe(0.5);
    });

    it('для значения ниже первого пресета берёт первый, затем второй', () => {
      expect(AdminSettingsPresets.cycle(0.01, AdminSettingsPresets.CRIMINAL_THRESHOLD)).toBe(0.4);
    });
  });

  it('toggle инвертирует булево значение', () => {
    expect(AdminSettingsPresets.toggle(true)).toBe(false);
    expect(AdminSettingsPresets.toggle(false)).toBe(true);
  });

  it('percent форматирует долю как целые проценты', () => {
    expect(AdminSettingsPresets.percent(0.5)).toBe('50%');
    expect(AdminSettingsPresets.percent(0.425)).toBe('43%');
    expect(AdminSettingsPresets.percent(0)).toBe('0%');
  });

  it('duration форматирует длительность на всех границах', () => {
    expect(AdminSettingsPresets.duration(0)).toBe('без паузы');
    expect(AdminSettingsPresets.duration(-5)).toBe('без паузы');
    expect(AdminSettingsPresets.duration(30)).toBe('30 с');
    expect(AdminSettingsPresets.duration(300)).toBe('5 мин');
    expect(AdminSettingsPresets.duration(7200)).toBe('2 ч');
  });
});
