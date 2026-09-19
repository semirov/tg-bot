import { Menu, MenuFlavor } from '@grammyjs/menu';
import { BotContext } from '../bot/interfaces/bot-context.interface';

/**
 * Небольшие чистые хелперы сборки меню, общие для admin/moderator/main меню.
 *
 * Не хранит состояние и не зависит от сервисов: только оборачивает обработчики
 * и собирает повторяющиеся переходы между меню. Вынесено из
 * `AdminMenuService`/`ModeratorMenuService`, которые оставляют у себя тонкие
 * делегирующие обёртки.
 */
export class MenuPresenter {
  /**
   * Пропускает действие только для владельца; остальным пишет отказ.
   *
   * @param handler обработчик, выполняемый для владельца
   * @returns обёрнутый обработчик меню
   */
  public ownerGuard(
    handler: (ctx: BotContext & MenuFlavor) => Promise<void> | void
  ): (ctx: BotContext & MenuFlavor) => Promise<void> {
    return async (ctx: BotContext & MenuFlavor): Promise<void> => {
      if (!ctx.config?.isOwner) {
        try {
          await ctx.answerCallbackQuery('Доступно только владельцу');
        } catch {
          // callback уже мог быть отвечён
        }
        return;
      }
      await handler(ctx);
    };
  }

  /**
   * Собирает обработчик кнопки перехода в другое меню.
   *
   * @param menu меню, которое нужно показать пользователю
   * @returns обработчик, отправляющий подсказку с клавиатурой меню
   */
  public switchToMenu(menu: Menu<BotContext>): (ctx: BotContext) => Promise<unknown> {
    return (ctx: BotContext) =>
      ctx.reply('Выбери то, что хочешь сделать', {
        reply_markup: menu,
      });
  }
}
