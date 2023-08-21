import {Inject, Injectable} from '@nestjs/common';
import {Bot} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {BOT} from '../providers/bot.provider';
import {Conversation, createConversation} from '@grammyjs/conversations';
import {Menu} from '@grammyjs/menu';
import {BaseConfigService} from '../../config/base-config.service';
import {InjectRepository} from '@nestjs/typeorm';
import {Repository} from 'typeorm';
import {PredictionsEntity} from '../entities/predictions.entity';
import {InlineQueryResultArticle} from '@grammyjs/types/inline';
import {format} from 'date-fns';
import {UserPredictionEntity} from '../entities/user-prediction.entity';

@Injectable()
export class PredictionFunService {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    @InjectRepository(PredictionsEntity)
    private predictionsEntity: Repository<PredictionsEntity>,
    @InjectRepository(UserPredictionEntity)
    private userPredictionEntity: Repository<UserPredictionEntity>
  ) {
  }

  public init(): void {
    this.buildPredictionVoteMenu();
    this.bot.use(createConversation(this.addPredictionConversation.bind(this), 'addPredictionCv'));
  }

  private predictionVoteMenu: Menu<BotContext>;

  private buildPredictionVoteMenu(): void {
    this.predictionVoteMenu = new Menu<BotContext>('prediction_vote_menu')
      .text('Добавить', async (ctx) => {
        await this.predictionsEntity.insert({prediction: ctx.callbackQuery.message.text});
        await ctx.deleteMessage();
      })
      .text('Отклонить', async (ctx) => {
        await ctx.deleteMessage();
      })
      .row();
    this.bot.use(this.predictionVoteMenu);
  }

  public async getPredictionForUserId(userId: number): Promise<string> {
    const actualDate = format(new Date(), 'dd-MM-yyyy');

    const userPrediction = await this.userPredictionEntity.findOne({
      where: {userId: userId},
    });

    let predictionId;

    if (userPrediction?.predictionId && userPrediction?.actualPredictionDate === actualDate) {
      predictionId = userPrediction.predictionId;
    } else {
      const predictionIds = await this.predictionsEntity.find({select: ['id']});
      const randomElement = predictionIds[Math.floor(Math.random() * predictionIds.length)]
      predictionId = randomElement.id;
      await this.userPredictionEntity.upsert(
        {
          userId: userId,
          predictionId: predictionId,
          actualPredictionDate: actualDate,
        },
        ['userId']
      );
    }

    const predictionEntity = await this.predictionsEntity.findOne({where: {id: predictionId}});
    return predictionEntity.prediction;
  }

  public async answerPredictionInlineQuery(ctx: BotContext): Promise<InlineQueryResultArticle> {
    const text = await this.getPredictionForUserId(ctx.inlineQuery.from.id);
    const prediction = `Твое предсказание на сегодня:\n\n<i>${text}</i>`;

    return {
      id: `prediction_query`,
      type: 'article',
      title: 'Предсказание',
      description: 'Получи свое предсказание на сегодня',
      input_message_content: {
        message_text: prediction,
        parse_mode: 'HTML',
      },
    };
  }

  public async addPredictionConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    await ctx.reply(
      'Представь себя предсказателем и напиши текст который ты бы хотел видеть как предсказание, ' +
      'если текст одобрят, бот его будет отправлять когда его попросят сделать предсказание' +
      '\n\nЕсли передумал нажми /cancel'
    );

    let replyCtx: BotContext = null;
    while (!replyCtx?.message?.text) {
      replyCtx = await conversation.wait();
      if (replyCtx?.message?.text === '/cancel') {
        await ctx.reply('Окей, не будем создавать');
        replyCtx = null;
        return;
      }
      if (!replyCtx?.message?.text) {
        await ctx.reply(
          'Сообщение может содержать только текст, если передумал добавлять предсказание, нажми\n/cancel'
        );
        replyCtx = null;
      }
    }

    await replyCtx.copyMessage(this.baseConfigService.ownerId, {
      reply_markup: this.predictionVoteMenu,
    });
    await replyCtx.reply('Спасибо, возможно твое предсказание будет добавлено');
  }
}
