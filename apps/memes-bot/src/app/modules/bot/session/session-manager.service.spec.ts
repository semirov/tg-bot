import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SessionManagerService } from './session-manager.service';
import { SessionEntity } from './session.entity';

describe('SessionManagerService', () => {
  it('отдаёт ровно тот репозиторий, что передан в конструктор', () => {
    const repository = { findOne: jest.fn(), save: jest.fn() } as any;
    const service = new SessionManagerService(repository);

    expect(service.getRepository()).toBe(repository);
    expect(service.getRepository()).toBe(service.getRepository());
  });

  it('получает репозиторий сессий через Nest DI по токену SessionEntity', async () => {
    const repository = { marker: 'sessions' } as any;
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionManagerService,
        { provide: getRepositoryToken(SessionEntity), useValue: repository },
      ],
    }).compile();

    const service = moduleRef.get(SessionManagerService);

    expect(service.getRepository()).toBe(repository);
  });
});
