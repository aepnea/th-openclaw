export interface GmailPubSubEnvelope {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

export interface GmailPubSubToolContext {
  trigger: "gmail_pubsub";
  emailAddress: string;
  historyId: string;
  webhookId?: string;
  messageId?: string;
  publishTime?: string;
  subscription?: string;
  suggestedTool: {
    name: "google_gmail";
    action: "search_messages";
    query: string;
  };
}

function decodeDataPayload(dataBase64?: string): Record<string, unknown> {
  if (!dataBase64) return {};

  if (typeof atob !== "function") {
    throw new Error("base64 decoder is not available in this runtime");
  }

  const decoded = atob(dataBase64);
  if (!decoded.trim()) return {};

  return JSON.parse(decoded) as Record<string, unknown>;
}

export function adaptGmailPubSubEvent(envelope: GmailPubSubEnvelope): GmailPubSubToolContext {
  const message = envelope.message ?? {};
  const attributes = message.attributes ?? {};

  const payload = decodeDataPayload(message.data);
  const emailAddress = String(payload.emailAddress ?? attributes.emailAddress ?? "").trim();
  const historyId = String(payload.historyId ?? attributes.historyId ?? "").trim();

  if (!emailAddress || !historyId) {
    throw new Error("gmail pubsub payload missing required emailAddress/historyId");
  }

  return {
    trigger: "gmail_pubsub",
    emailAddress,
    historyId,
    webhookId: attributes.webhook_id,
    messageId: message.messageId,
    publishTime: message.publishTime,
    subscription: envelope.subscription,
    suggestedTool: {
      name: "google_gmail",
      action: "search_messages",
      query: "newer_than:2d in:inbox",
    },
  };
}

export function buildGmailTriagePrompt(context: GmailPubSubToolContext): string {
  return [
    "New Gmail push event received. Perform inbox triage.",
    `Context: emailAddress=${context.emailAddress} historyId=${context.historyId}`,
    `Call ${context.suggestedTool.name} with action=${context.suggestedTool.action} and query=\"${context.suggestedTool.query}\".`,
    "Return top actionable emails and suggested next steps.",
  ].join("\n");
}
