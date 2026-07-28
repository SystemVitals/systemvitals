export interface ManagedTelegramBot {
  available: boolean;
  id: string | null;
  username: string | null;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
}

export interface TelegramMessageResult {
  message_id: number;
}

export interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export type TelegramFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;
