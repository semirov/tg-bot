import {Controller, Get} from '@nestjs/common';
import {BullBoardInstance, InjectBullBoard} from '@bull-board/nestjs';

@Controller('queue')
export class QueueController {
  constructor(
    @InjectBullBoard() private readonly boardInstance: BullBoardInstance
  ) {
  }

  @Get()
  getFeature() {
    return 'ok';
  }
}
