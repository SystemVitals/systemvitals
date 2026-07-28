export interface TelegramStartUpdate {
  updateId: string;
  chatId: string;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle: string | null;
  messageThreadId?: number;
}

type TelegramChatType = TelegramStartUpdate['chatType'];
const POSTGRESQL_INTEGER_MAX = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChatType(value: unknown): value is TelegramChatType {
  return (
    value === 'private' ||
    value === 'group' ||
    value === 'supergroup' ||
    value === 'channel'
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseTelegramStartUpdate(
  input: unknown,
  botUsername: string,
): TelegramStartUpdate | null {
  if (
    !isRecord(input) ||
    typeof input.update_id !== 'number' ||
    !Number.isSafeInteger(input.update_id) ||
    input.update_id <= 0 ||
    botUsername.length === 0
  ) {
    return null;
  }

  const hasMessage = input.message !== undefined;
  const hasChannelPost = input.channel_post !== undefined;
  if (hasMessage === hasChannelPost) {
    return null;
  }

  const post = hasMessage ? input.message : input.channel_post;
  if (!isRecord(post) || typeof post.text !== 'string') {
    return null;
  }

  const escapedUsername = escapeRegExp(botUsername);
  const commandPattern = new RegExp(
    `^/start(?:@${escapedUsername})?(?:\\s+\\S+)?$`,
    'i',
  );
  const commandMatch = post.text.match(commandPattern);
  if (commandMatch?.[0] !== post.text) {
    return null;
  }

  if (!isRecord(post.chat)) {
    return null;
  }
  const chat = post.chat;
  if (
    typeof chat.id !== 'number' ||
    !Number.isSafeInteger(chat.id) ||
    chat.id === 0 ||
    !isChatType(chat.type)
  ) {
    return null;
  }
  if (
    (chat.title !== undefined && typeof chat.title !== 'string') ||
    (chat.username !== undefined && typeof chat.username !== 'string')
  ) {
    return null;
  }

  const messageThreadId = post.message_thread_id;
  if (
    messageThreadId !== undefined &&
    (typeof messageThreadId !== 'number' ||
      !Number.isSafeInteger(messageThreadId) ||
      messageThreadId <= 0 ||
      messageThreadId > POSTGRESQL_INTEGER_MAX)
  ) {
    return null;
  }

  const result: TelegramStartUpdate = {
    updateId: String(input.update_id),
    chatId: String(chat.id),
    chatType: chat.type,
    chatTitle: chat.title ?? chat.username ?? null,
  };
  if (typeof messageThreadId === 'number') {
    result.messageThreadId = messageThreadId;
  }
  return result;
}
