import {Injectable} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {ClientEntity} from '../entities/client.entity';
import {LessThan, Repository} from 'typeorm';
import {sub} from 'date-fns';
import {firstValueFrom} from 'rxjs';

@Injectable()
export class ClientsRepositoryService {
  constructor(@InjectRepository(ClientEntity) private clientRepository: Repository<ClientEntity>) {
  }

  public async updatePartialById(id: number, client: Partial<ClientEntity>): Promise<void> {
    await this.clientRepository.update({botId: id}, client);
  }

  public findClientUpdateMoreThanSomeSecAgo(seconds: number): Promise<ClientEntity[]> {
    return this.clientRepository.find({
      where: {active: true, lastPing: LessThan(sub(new Date(), {seconds}))},
      order: {id: 'ASC'},
    });
  }

  public findClientByBotId(botId: number): Promise<ClientEntity> {
    return this.clientRepository.findOneBy({botId});
  }

  public createClient(client: Partial<ClientEntity>): Promise<ClientEntity> {
    const clientEntity = this.clientRepository.create(client);
    return this.clientRepository.save(clientEntity);
  }

  public async getBotIdsByAdminId(id: number): Promise<number[]> {
    const partialClients = await this.clientRepository.find({
      where: {adminUserId: id},
      select: ['botId'],
    });
    return partialClients.map((v) => v.botId);
  }

  public async getClientsByAdminId(id: number): Promise<ClientEntity[]> {
    return await this.clientRepository.find({
      where: {adminUserId: id},
      order: {id: 'ASC'},
    });
  }

  async updateBotUsernameByBotId(botId: number, botUsername: string | undefined): Promise<void> {
    if (!botUsername) {
      return Promise.resolve();
    }
    return await void this.clientRepository.update({botId}, {botUsername});
  }
}
