import { Clock } from '../../../shared/clock';
import { TrollCooldownRegistry } from './troll-cooldown-registry';

/** Детерминированные часы для проверки кулдаунов. */
class FakeClock implements Clock {
  public value = 0;

  public now(): Date {
    return new Date(this.value);
  }

  public timestamp(): number {
    return this.value;
  }
}

describe('TrollCooldownRegistry', () => {
  it('создаётся с системными часами по умолчанию', () => {
    const registry = new TrollCooldownRegistry();
    const store = new Map<string, number>([['chat:1', Date.now()]]);

    expect(registry.withinCooldown(store, 'chat:1', 60)).toBe(true);
    expect(registry.withinCooldown(new Map([['chat:1', 0]]), 'chat:1', 60)).toBe(false);
  });

  it('держит карты last*At доступными для чтения', () => {
    const registry = new TrollCooldownRegistry();

    expect(registry.lastAnalysisAt).toBeInstanceOf(Map);
    expect(registry.lastSarcasmAt).toBeInstanceOf(Map);
    expect(registry.lastMirrorAt).toBeInstanceOf(Map);
    expect(registry.lastReactionAt).toBeInstanceOf(Map);
    expect(registry.lastStatAt).toBeInstanceOf(Map);
    expect(registry.lastJerkAnswerAt).toBeInstanceOf(Map);
  });

  it('не считает кулдаун при нулевой или отрицательной длительности', () => {
    const clock = new FakeClock();
    const registry = new TrollCooldownRegistry(clock);
    const store = new Map<number, number>([[1, 1000]]);

    clock.value = 1001;
    expect(registry.withinCooldown(store, 1, 0)).toBe(false);
    expect(registry.withinCooldown(store, 1, -5)).toBe(false);
  });

  it('не считает кулдаун для отсутствующей записи', () => {
    const registry = new TrollCooldownRegistry(new FakeClock());

    expect(registry.withinCooldown(new Map<number, number>(), 1, 60)).toBe(false);
  });

  it('считает кулдаун, пока не истёк срок', () => {
    const clock = new FakeClock();
    const registry = new TrollCooldownRegistry(clock);
    const store = new Map<number, number>([[1, 10_000]]);

    clock.value = 10_000 + 59_000;
    expect(registry.withinCooldown(store, 1, 60)).toBe(true);
  });

  it('снимает кулдаун ровно по истечении срока', () => {
    const clock = new FakeClock();
    const registry = new TrollCooldownRegistry(clock);
    const store = new Map<number, number>([[1, 10_000]]);

    clock.value = 10_000 + 60_000;
    expect(registry.withinCooldown(store, 1, 60)).toBe(false);
  });

  it('работает со строковыми ключами', () => {
    const clock = new FakeClock();
    const registry = new TrollCooldownRegistry(clock);
    const store = new Map<string, number>([['1:2', 5000]]);

    clock.value = 5000 + 1000;
    expect(registry.withinCooldown(store, '1:2', 60)).toBe(true);
    expect(registry.withinCooldown(store, 'другой', 60)).toBe(false);
  });
});
