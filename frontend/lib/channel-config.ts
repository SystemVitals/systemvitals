export type ChannelType = "EMAIL" | "SLACK" | "TELEGRAM" | "WEBHOOK";
export type CreatableChannelType = "EMAIL" | "SLACK" | "WEBHOOK";

export interface EmailFields {
  email: string;
}

export interface SlackFields {
  webhookUrl: string;
}

export interface WebhookFields {
  url: string;
}

export type ChannelFields = EmailFields | SlackFields | WebhookFields;

/**
 * Pure helper: given a channel type and its required fields,
 * returns the JSON string expected by the API `configJson` argument.
 */
export function buildChannelConfig(type: "EMAIL", fields: EmailFields): string;
export function buildChannelConfig(type: "SLACK", fields: SlackFields): string;
export function buildChannelConfig(type: "WEBHOOK", fields: WebhookFields): string;
export function buildChannelConfig(
  type: CreatableChannelType,
  fields: ChannelFields
): string {
  switch (type) {
    case "EMAIL": {
      const { email } = fields as EmailFields;
      return JSON.stringify({ email });
    }
    case "SLACK": {
      const { webhookUrl } = fields as SlackFields;
      return JSON.stringify({ webhookUrl });
    }
    case "WEBHOOK": {
      const { url } = fields as WebhookFields;
      return JSON.stringify({ url });
    }
  }
}
