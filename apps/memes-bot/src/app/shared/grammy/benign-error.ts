import { GrammyError } from 'grammy';

/**
 * True for Telegram's `400 Bad Request: message is not modified`.
 *
 * `editMessageReplyMarkup` is a cosmetic step that runs *after* a post is
 * already in the channel. When the target keyboard is already set, Telegram
 * rejects the edit; treating that as a failure used to abort the publish
 * pipeline after the post was sent (TGB-117). Any other error is a real
 * failure and must propagate.
 *
 * @param error value caught around a Telegram API call
 * @returns `true` only for the "message is not modified" 400 answer
 */
export function isMessageNotModifiedError(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    /message is not modified/i.test(error.description)
  );
}
