import {Injectable} from '@nestjs/common';
import {BotContext} from '../interfaces/bot-context.interface';
import {InjectRepository} from '@nestjs/typeorm';
import {InsertResult, Repository} from 'typeorm';
import {UserEntity} from '../entities/user.entity';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>
  ) {
  }

  public get repository(): Repository<UserEntity> {
    return this.userRepository;
  }

  public findById(id: number): Promise<UserEntity | undefined> {
    return this.userRepository.findOne({where: {id}});
  }

  public getUsers(): Promise<UserEntity[]> {
    return this.userRepository.find({where: {canSendMessages: true}});
  }

  public async disableSendMessageForUser(userId: number): Promise<void> {
    await this.userRepository.update({id: userId}, {canSendMessages: false});
  }

  public updateUserLastActivity(ctx: BotContext): Promise<InsertResult> {
    return this.userRepository.upsert(
      {
        id: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        isBot: ctx.from.is_bot,
        lastActivity: new Date(),
      },
      ['id']
    );
  }
}
