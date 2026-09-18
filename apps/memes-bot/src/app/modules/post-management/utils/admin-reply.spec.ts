import { resolveAdminReply } from './admin-reply';

const REQUEST_CHANNEL = -1001709979748;

describe('resolveAdminReply', () => {
  it('разбирает channel_post-ответ в канале обращений', () => {
    const result = resolveAdminReply(
      {
        channelPost: {
          message_id: 200,
          reply_to_message: { message_id: 100 },
        },
        chat: { id: REQUEST_CHANNEL },
      },
      REQUEST_CHANNEL
    );

    expect(result).toEqual({
      replyToMessageId: 100,
      adminMessageId: 200,
      chatId: REQUEST_CHANNEL,
    });
  });

  it('разбирает обычный message-ответ (channelPost отсутствует)', () => {
    // Именно этот апдейт ронял обработчик: ctx.channelPost === undefined.
    const result = resolveAdminReply(
      {
        message: {
          message_id: 200,
          reply_to_message: { message_id: 100 },
        },
        chat: { id: REQUEST_CHANNEL },
      },
      REQUEST_CHANNEL
    );

    expect(result).toEqual({
      replyToMessageId: 100,
      adminMessageId: 200,
      chatId: REQUEST_CHANNEL,
    });
  });

  it('не принимает ответ из стороннего чата с совпавшим message_id', () => {
    const result = resolveAdminReply(
      {
        message: {
          message_id: 200,
          reply_to_message: { message_id: 100 },
        },
        chat: { id: -100999 },
      },
      REQUEST_CHANNEL
    );

    expect(result).toBeNull();
  });

  it('возвращает null без reply_to_message', () => {
    expect(
      resolveAdminReply(
        { message: { message_id: 200 }, chat: { id: REQUEST_CHANNEL } },
        REQUEST_CHANNEL
      )
    ).toBeNull();
  });

  it('возвращает null без chat', () => {
    expect(
      resolveAdminReply(
        { message: { message_id: 200, reply_to_message: { message_id: 100 } } },
        REQUEST_CHANNEL
      )
    ).toBeNull();
  });

  it('возвращает null, если нет ни channelPost, ни message', () => {
    expect(resolveAdminReply({ chat: { id: REQUEST_CHANNEL } }, REQUEST_CHANNEL)).toBeNull();
  });
});
