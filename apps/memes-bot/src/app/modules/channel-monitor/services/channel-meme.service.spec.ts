import { ChannelMemeEntity } from '../entities/channel-meme.entity';
import { ChannelMemeService } from './channel-meme.service';

function makeRepo(): any {
  return {
    findOne: jest.fn(),
    count: jest.fn(),
    find: jest.fn(),
  };
}

function makeMeme(id: number): ChannelMemeEntity {
  return Object.assign(new ChannelMemeEntity(), { id, channelType: 'main', s3Key: `k/${id}` });
}

describe('ChannelMemeService', () => {
  let repo: any;
  let service: ChannelMemeService;

  beforeEach(() => {
    repo = makeRepo();
    service = new ChannelMemeService(repo);
  });

  it('getLastMeme: последний мем main-канала', async () => {
    const meme = makeMeme(1);
    repo.findOne.mockResolvedValue(meme);

    await expect(service.getLastMeme()).resolves.toBe(meme);
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { channelType: 'main' },
      order: { createdAt: 'DESC' },
    });
  });

  it('getLastBestMeme: последний мем best-канала', async () => {
    const meme = makeMeme(2);
    repo.findOne.mockResolvedValue(meme);

    await expect(service.getLastBestMeme()).resolves.toBe(meme);
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { channelType: 'best' },
      order: { createdAt: 'DESC' },
    });
  });

  it('getRandomMeme: пусто → null', async () => {
    repo.count.mockResolvedValue(0);

    await expect(service.getRandomMeme()).resolves.toBeNull();
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('getRandomMeme: есть записи → случайный', async () => {
    const meme = makeMeme(3);
    repo.count.mockResolvedValue(5);
    repo.find.mockResolvedValue([meme]);
    jest.spyOn(Math, 'random').mockReturnValue(0.4);

    await expect(service.getRandomMeme()).resolves.toBe(meme);
    expect(repo.find).toHaveBeenCalledWith({ skip: 2, take: 1 });
  });

  it('getRandomMeme: find вернул пусто → null', async () => {
    repo.count.mockResolvedValue(1);
    repo.find.mockResolvedValue([]);

    await expect(service.getRandomMeme()).resolves.toBeNull();
  });

  it('getRandomMemeByType: пусто → null', async () => {
    repo.count.mockResolvedValue(0);

    await expect(service.getRandomMemeByType('best')).resolves.toBeNull();
    expect(repo.count).toHaveBeenCalledWith({ where: { channelType: 'best' } });
  });

  it('getRandomMemeByType: есть записи → случайный', async () => {
    const meme = makeMeme(4);
    repo.count.mockResolvedValue(3);
    repo.find.mockResolvedValue([meme]);

    await expect(service.getRandomMemeByType('main')).resolves.toBe(meme);
    expect(repo.find).toHaveBeenCalledWith({ where: { channelType: 'main' }, skip: expect.any(Number), take: 1 });
  });
});
