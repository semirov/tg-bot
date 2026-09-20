import { ParserClientService } from './parser-client.service';

describe('ParserClientService', () => {
  it('клиент поднят → возвращает клиент', () => {
    const client = { connected: true };
    const service = new ParserClientService({ activeClient: client } as never);
    expect(service.client()).toBe(client);
  });

  it('клиент не поднят → undefined', () => {
    const service = new ParserClientService({ activeClient: undefined } as never);
    expect(service.client()).toBeUndefined();
  });
});
