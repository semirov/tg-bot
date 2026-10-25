import { MtprotoFloodGate, mtprotoFloodGate } from './mtproto-flood-gate';

const NOW = new Date('2026-10-25T00:00:00Z').getTime();

describe('MtprotoFloodGate', () => {
  let gate: MtprotoFloodGate;

  beforeEach(() => {
    gate = new MtprotoFloodGate();
  });

  it('без FloodWait паузы нет', () => {
    expect(gate.until(NOW)).toBeNull();
    expect(gate.isBlocked(NOW)).toBe(false);
  });

  it('block задаёт дедлайн и учитывает jitter', () => {
    expect(gate.block(100, 0, NOW)).toBe(NOW + 100_000);
    expect(gate.until(NOW)).toBe(NOW + 100_000);
    expect(gate.isBlocked(NOW + 99_999)).toBe(true);

    const jittered = new MtprotoFloodGate();
    expect(jittered.block(10, 750, NOW)).toBe(NOW + 10_750);
  });

  it('то же ожидание, отчётом позже, не продлевает паузу и не считается новым', () => {
    const first = gate.block(100, 0, NOW);
    expect(first).toBe(NOW + 100_000);

    expect(gate.block(100, 0, NOW + 30_000)).toBeNull();
    expect(gate.until(NOW + 30_000)).toBe(NOW + 100_000);
  });

  it('меньшее ожидание игнорируется, большее — продлевает от момента отчёта', () => {
    gate.block(100, 0, NOW);

    expect(gate.block(50, 0, NOW + 1_000)).toBeNull();
    expect(gate.until(NOW + 1_000)).toBe(NOW + 100_000);

    expect(gate.block(5_000, 0, NOW + 2_000)).toBe(NOW + 5_002_000);
  });

  it('истёкшая пауза сбрасывается, новое ожидание регистрируется заново', () => {
    gate.block(10, 0, NOW);

    expect(gate.until(NOW + 10_001)).toBeNull();
    expect(gate.isBlocked(NOW + 10_001)).toBe(false);
    // Даже меньшее, чем прошлое, ожидание теперь новое.
    expect(gate.block(5, 0, NOW + 10_001)).toBe(NOW + 15_001);
  });

  it('reset снимает паузу', () => {
    gate.block(10, 0, NOW);
    gate.reset();
    expect(gate.isBlocked(NOW)).toBe(false);
  });

  it('процессный singleton — экземпляр MtprotoFloodGate', () => {
    expect(mtprotoFloodGate).toBeInstanceOf(MtprotoFloodGate);
  });
});
