import { GrammyError, HttpError } from 'grammy';
import { isMessageNotModifiedError } from './benign-error';

function grammyError(error_code: number, description: string, method: string): GrammyError {
  return new GrammyError(
    `Call to '${method}' failed!`,
    { ok: false, error_code, description },
    method,
    {}
  );
}

describe('isMessageNotModifiedError', () => {
  it('recognises the 400 "message is not modified" answer', () => {
    const error = grammyError(400, 'Bad Request: message is not modified', 'editMessageReplyMarkup');

    expect(isMessageNotModifiedError(error)).toBe(true);
  });

  it('matches the description case-insensitively', () => {
    const error = grammyError(400, 'Bad Request: MESSAGE IS NOT MODIFIED', 'editMessageReplyMarkup');

    expect(isMessageNotModifiedError(error)).toBe(true);
  });

  it('ignores other Telegram 400 answers', () => {
    const error = grammyError(400, 'Bad Request: message to edit not found', 'editMessageReplyMarkup');

    expect(isMessageNotModifiedError(error)).toBe(false);
  });

  it('ignores the same description with a non-400 code', () => {
    const error = grammyError(403, 'message is not modified', 'editMessageReplyMarkup');

    expect(isMessageNotModifiedError(error)).toBe(false);
  });

  it('ignores non-Telegram errors and plain values', () => {
    expect(isMessageNotModifiedError(new Error('message is not modified'))).toBe(false);
    expect(isMessageNotModifiedError(new HttpError('fetch failed', new Error('boom')))).toBe(false);
    expect(isMessageNotModifiedError(undefined)).toBe(false);
    expect(isMessageNotModifiedError('message is not modified')).toBe(false);
  });
});
