import { Menu } from '@grammyjs/menu';
import { Context, InlineKeyboard } from 'grammy';

/** Plain inline-keyboard payload accepted as grammY `reply_markup`. */
export type RenderedMenu = {
  inline_keyboard: NonNullable<ConstructorParameters<typeof InlineKeyboard>[0]>;
};

/**
 * Renders a grammY `Menu` into a plain inline keyboard payload.
 *
 * `@grammyjs/menu` ships a transformer that rewrites `reply_markup` right before
 * an API call, but that transformer is installed by the menu middleware on the
 * **per-update `ctx.api`** (grammY creates a fresh `Api` for every update in
 * `handleUpdate`). A context hydrated inside `@grammyjs/conversations` gets a
 * fresh `Api` without it, and `bot.api` never has it either — so passing a raw
 * `Menu` as `reply_markup` in those contexts throws `Cannot send menu '<id>'`.
 * Rendering explicitly makes the payload valid in any context; clicks keep
 * working because the menu middleware is installed with `bot.use()` and the
 * callback data carries the menu id.
 *
 * NOTE: this relies on `Menu.render` being `protected` in the pinned
 * `@grammyjs/menu@1.5.0` (see the coupling guard in `render-menu.spec.ts`).
 * Revisit the cast when upgrading the plugin.
 */
export async function renderMenu<C extends Context>(menu: Menu<C>, ctx: C): Promise<RenderedMenu> {
  const renderer = menu as unknown as {
    render(context: C): Promise<NonNullable<ConstructorParameters<typeof InlineKeyboard>[0]>>;
  };
  return { inline_keyboard: await renderer.render(ctx) };
}
