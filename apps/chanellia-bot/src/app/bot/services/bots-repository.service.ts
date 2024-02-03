import {Injectable} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {BotEntity} from '../entities/bot.entity';
import {LessThan, Repository} from 'typeorm';
import {sub} from 'date-fns';

@Injectable()
export class BotsRepositoryService {
  constructor(@InjectRepository(BotEntity) private botsRepository: Repository<BotEntity>) {
  }

  public async updatePartialById(id: number, client: Partial<BotEntity>): Promise<void> {
    await this.botsRepository.update({botId: id}, client);
  }

  public findClientUpdateMoreThanSomeSecAgo(seconds: number): Promise<BotEntity[]> {
    return this.botsRepository.find({
      where: {lastPing: LessThan(sub(new Date(), {seconds}))},
      order: {id: 'ASC'},
    });
  }

  public findClientByBotId(botId: number): Promise<BotEntity> {
    return this.botsRepository.findOneBy({botId});
  }

  public findClientByToken(token: string): Promise<BotEntity> {
    return this.botsRepository.findOneBy({botToken: token});
  }

  public createClient(client: Partial<BotEntity>): Promise<BotEntity> {
    const clientEntity = this.botsRepository.create(client);
    return this.botsRepository.save(clientEntity);
  }

  public async getBotIdsByAdminId(id: number): Promise<number[]> {
    const partialClients = await this.botsRepository.find({
      where: {user: {id}},
      select: ['botId'],
    });
    return partialClients.map((v) => v.botId);
  }

  public async getClientsByAdminId(id: number): Promise<BotEntity[]> {
    return await this.botsRepository.find({
      where: {user: {id}},
      order: {id: 'ASC'},
    });
  }

  async updateBotUsernameByBotId(botId: number, botUsername: string | undefined): Promise<void> {
    if (!botUsername) {
      return Promise.resolve();
    }
    return await void this.botsRepository.update({botId}, {botUsername});
  }

  async botsCountByAdminId(adminId: number): Promise<number> {
    return this.botsRepository.count({where: {user: {id: adminId}}});
  }

  public async deleteClient(id: number): Promise<void> {
    return await void this.botsRepository.softDelete({id});
  }
}
