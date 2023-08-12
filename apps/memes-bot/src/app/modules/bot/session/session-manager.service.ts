import { Injectable } from '@nestjs/common';
import { SessionEntity } from './session.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

@Injectable()
export class SessionManagerService {
  constructor(
    @InjectRepository(SessionEntity)
    private usersRepository: Repository<SessionEntity>
  ) {}

  public getRepository(): Repository<SessionEntity> {
    return this.usersRepository;
  }
}
