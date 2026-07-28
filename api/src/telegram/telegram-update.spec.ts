import { parseTelegramStartUpdate } from './telegram-update';

const BOT_USERNAME = 'SystemVitalsBot';

function messageUpdate(overrides: Record<string, unknown> = {}): unknown {
  return {
    update_id: 101,
    message: {
      message_id: 7,
      text: '/start@SystemVitalsBot',
      message_thread_id: 42,
      chat: {
        id: -1001234567890,
        type: 'supergroup',
        title: 'Operations',
      },
    },
    ...overrides,
  };
}

describe('parseTelegramStartUpdate', () => {
  it('parses an addressed supergroup start in a topic', () => {
    expect(parseTelegramStartUpdate(messageUpdate(), BOT_USERNAME)).toEqual({
      updateId: '101',
      chatId: '-1001234567890',
      chatType: 'supergroup',
      chatTitle: 'Operations',
      messageThreadId: 42,
    });
  });

  it('parses channel_post from its own text and chat', () => {
    const payload = {
      update_id: 102,
      channel_post: {
        message_id: 8,
        text: '/start',
        chat: {
          id: -1009876543210,
          type: 'channel',
          title: 'Deployment Notices',
        },
      },
    };

    expect(parseTelegramStartUpdate(payload, BOT_USERNAME)).toEqual({
      updateId: '102',
      chatId: '-1009876543210',
      chatType: 'channel',
      chatTitle: 'Deployment Notices',
    });
  });

  it('uses a private chat username as the display title when title is absent', () => {
    const payload = {
      update_id: 103,
      message: {
        message_id: 9,
        text: '/start setup-payload',
        chat: {
          id: 7654321,
          type: 'private',
          username: 'synthetic_operator',
        },
      },
    };

    expect(parseTelegramStartUpdate(payload, BOT_USERNAME)).toEqual({
      updateId: '103',
      chatId: '7654321',
      chatType: 'private',
      chatTitle: 'synthetic_operator',
    });
  });

  it.each([
    '/start',
    '/START',
    '/start payload',
    '/start\tpayload',
    '/start@SystemVitalsBot',
    '/START@systemvitalsbot',
    '/start@SystemVitalsBot payload',
    '/start@systemvitalsbot\tpayload',
  ])('accepts the exact supported command %p', (text) => {
    const payload = messageUpdate({
      message: {
        text,
        chat: { id: -123456, type: 'group', title: 'Synthetic Group' },
      },
    });

    expect(parseTelegramStartUpdate(payload, BOT_USERNAME)).toMatchObject({
      updateId: '101',
      chatId: '-123456',
      chatType: 'group',
    });
  });

  it('escapes the configured bot username in the command expression', () => {
    const configuredUsername = 'SystemVitals.Bot';
    const exact = messageUpdate({
      message: {
        text: '/start@SystemVitals.Bot',
        chat: { id: 123456, type: 'private' },
      },
    });
    const regexLookalike = messageUpdate({
      message: {
        text: '/start@SystemVitalsXBot',
        chat: { id: 123456, type: 'private' },
      },
    });

    expect(parseTelegramStartUpdate(exact, configuredUsername)).not.toBeNull();
    expect(
      parseTelegramStartUpdate(regexLookalike, configuredUsername),
    ).toBeNull();
  });

  it.each([
    ['substring prefix', 'please /start'],
    ['substring suffix', '/start-now'],
    ['extra argument', '/start one two'],
    ['payload trailing whitespace', '/start payload '],
    ['wrong addressed username', '/start@AnotherSyntheticBot'],
    ['unsupported command', '/help'],
    ['bare address marker', '/start@'],
    ['address plus extra marker', '/start@SystemVitalsBot@other'],
  ])('rejects %s', (_case, text) => {
    const payload = messageUpdate({
      message: {
        text,
        chat: { id: 123456, type: 'private' },
      },
    });

    expect(parseTelegramStartUpdate(payload, BOT_USERNAME)).toBeNull();
  });

  it.each([
    ['null input', null],
    ['array input', []],
    ['missing update id', { message: { text: '/start', chat: {} } }],
    [
      'zero update id',
      {
        update_id: 0,
        message: { text: '/start', chat: { id: 1, type: 'private' } },
      },
    ],
    [
      'negative update id',
      {
        update_id: -1,
        message: { text: '/start', chat: { id: 1, type: 'private' } },
      },
    ],
    [
      'non-integer update id',
      {
        update_id: 1.5,
        message: { text: '/start', chat: { id: 1, type: 'private' } },
      },
    ],
    [
      'unsafe update id',
      {
        update_id: Number.MAX_SAFE_INTEGER + 1,
        message: { text: '/start', chat: { id: 1, type: 'private' } },
      },
    ],
    ['missing post', { update_id: 1 }],
    ['non-object post', { update_id: 1, message: 'not-an-object' }],
    [
      'both post variants',
      {
        update_id: 1,
        message: {
          text: '/start',
          chat: { id: 1, type: 'private' },
        },
        channel_post: {
          text: '/start',
          chat: { id: 2, type: 'channel' },
        },
      },
    ],
    [
      'missing text',
      { update_id: 1, message: { chat: { id: 1, type: 'private' } } },
    ],
    [
      'non-string text',
      {
        update_id: 1,
        message: { text: 123, chat: { id: 1, type: 'private' } },
      },
    ],
    ['missing chat', { update_id: 1, message: { text: '/start' } }],
    [
      'missing chat id',
      {
        update_id: 1,
        message: { text: '/start', chat: { type: 'private' } },
      },
    ],
    [
      'zero chat id',
      {
        update_id: 1,
        message: { text: '/start', chat: { id: 0, type: 'private' } },
      },
    ],
    [
      'non-integer chat id',
      {
        update_id: 1,
        message: { text: '/start', chat: { id: 1.5, type: 'private' } },
      },
    ],
    [
      'unsafe chat id',
      {
        update_id: 1,
        message: {
          text: '/start',
          chat: { id: Number.MIN_SAFE_INTEGER - 1, type: 'private' },
        },
      },
    ],
    [
      'unsupported chat type',
      {
        update_id: 1,
        message: { text: '/start', chat: { id: 1, type: 'sender' } },
      },
    ],
    [
      'non-string title',
      {
        update_id: 1,
        message: {
          text: '/start',
          chat: { id: 1, type: 'private', title: 123 },
        },
      },
    ],
    [
      'non-string username',
      {
        update_id: 1,
        message: {
          text: '/start',
          chat: { id: 1, type: 'private', username: 123 },
        },
      },
    ],
  ])('rejects malformed payload: %s', (_case, payload) => {
    expect(parseTelegramStartUpdate(payload, BOT_USERNAME)).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['PostgreSQL Int overflow', 2_147_483_648],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['non-number', '42'],
  ])('rejects a %s topic id', (_case, messageThreadId) => {
    const payload = messageUpdate({
      message: {
        text: '/start',
        message_thread_id: messageThreadId,
        chat: { id: -123456, type: 'supergroup' },
      },
    });

    expect(parseTelegramStartUpdate(payload, BOT_USERNAME)).toBeNull();
  });

  it('takes text, chat, and topic only from the selected post', () => {
    const payload = {
      update_id: 104,
      text: '/start',
      message_thread_id: 42,
      chat: { id: -999, type: 'supergroup', title: 'Top level' },
      message: {
        text: '/help',
        chat: { id: -123, type: 'supergroup', title: 'Actual post' },
      },
    };

    expect(parseTelegramStartUpdate(payload, BOT_USERNAME)).toBeNull();
  });

  it('preserves a negative safe chat id with direct decimal conversion', () => {
    const chatId = Number.MIN_SAFE_INTEGER;
    const payload = messageUpdate({
      message: {
        text: '/start',
        chat: { id: chatId, type: 'group', title: 'Boundary Group' },
      },
    });

    expect(parseTelegramStartUpdate(payload, BOT_USERNAME)?.chatId).toBe(
      String(chatId),
    );
  });
});
