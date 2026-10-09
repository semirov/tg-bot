import { Menu } from '@grammyjs/menu';
import { Context } from 'grammy';
import { renderMenu } from './render-menu';

type TestContext = Context;

const MENU_ID = 'render-menu-test';

function makeMenu(): Menu<TestContext> {
  return new Menu<TestContext>(MENU_ID, { autoAnswer: false })
    .text('Approve', async () => undefined)
    .text('Reject', async () => undefined)
    .row();
}

describe('renderMenu', () => {
  it('renders a Menu into a plain inline keyboard payload', async () => {
    const menu = makeMenu();
    const ctx = {} as TestContext;

    const rendered = await renderMenu(menu, ctx);

    expect(rendered.inline_keyboard).toEqual(expect.any(Array));
    const [approve, reject] = rendered.inline_keyboard[0] as Array<{
      text: string;
      callback_data: string;
    }>;
    expect(approve.text).toBe('Approve');
    // Callback data carries the menu id, so the middleware (installed via
    // `bot.use`) keeps handling navigation after explicit rendering.
    expect(approve.callback_data).toContain(MENU_ID);
    expect(reject.callback_data).toContain(MENU_ID);
  });

  it('documents why explicit rendering is required: a raw Menu payload throws', () => {
    const menu = makeMenu();

    expect(() => (menu as unknown as { inline_keyboard: unknown[] }).inline_keyboard[0]).toThrow(
      /Cannot send menu/
    );
  });

  it('coupling guard: @grammyjs/menu@1.5.0 exposes the protected Menu.render used by the cast', () => {
    // `renderMenu` reaches the protected `Menu.render` of the pinned
    // `@grammyjs/menu@1.5.0`. If the plugin changes or removes it, revisit the
    // cast (and bump the dependency consciously) before upgrading.
    expect(typeof (Menu.prototype as unknown as { render?: unknown }).render).toBe('function');
  });
});
