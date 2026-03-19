import { gmail_v1 } from "googleapis";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createGoogleAuthClient } from "./auth.js";
import { GmailSchema, type GmailParams } from "./gmail-schemas.js";
import type { GoogleWorkspaceConfig } from "./config-schema.js";

/**
 * Helper to format JSON response for agent tools
 */
function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function decodeBase64Url(input?: string | null): string | null {
  if (!input) return null;
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const missing = padded.length % 4;
  const normalized = missing === 0 ? padded : `${padded}${"=".repeat(4 - missing)}`;
  return atob(normalized);
}

function encodeBase64Url(input: string): string {
  return btoa(input)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function assertWriteScope(config: GoogleWorkspaceConfig) {
  if (config.scopeProfile !== "write") {
    throw new Error("Action requires scopeProfile=write");
  }
}

function allRecipients(params: GmailParams): string[] {
  if (params.action !== "send_message") return [];
  return [...params.to, ...(params.cc ?? []), ...(params.bcc ?? [])];
}

function enforceRecipientPolicy(config: GoogleWorkspaceConfig, recipients: string[]) {
  const allowed = config.gmail.allowedRecipientDomains ?? [];
  if (allowed.length === 0) return;

  const allowedSet = new Set(allowed.map((d: string) => d.toLowerCase()));
  const invalid = recipients.filter((email) => {
    const domain = email.split("@")[1]?.toLowerCase();
    return !domain || !allowedSet.has(domain);
  });

  if (invalid.length > 0) {
    throw new Error(`Recipients not allowed by policy: ${invalid.join(", ")}`);
  }
}

function buildRawEmail(params: Extract<GmailParams, { action: "send_message" }>): string {
  const to = params.to.join(", ");
  const cc = (params.cc ?? []).join(", ");
  const bcc = (params.bcc ?? []).join(", ");
  const subject = params.subject;
  const bodyText = params.bodyText ?? "";
  const bodyHtml = params.bodyHtml;
  const attachments = params.attachments ?? [];

  const headers = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
  ];

  if (attachments.length === 0 && !bodyHtml) {
    const raw = [...headers, "Content-Type: text/plain; charset=UTF-8", "", bodyText].join("\r\n");
    return encodeBase64Url(raw);
  }

  const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const altBoundary = `alt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const lines: string[] = [...headers, `Content-Type: multipart/mixed; boundary=\"${mixedBoundary}\"`, ""];

  if (bodyHtml) {
    lines.push(`--${mixedBoundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary=\"${altBoundary}\"`);
    lines.push("");
    lines.push(`--${altBoundary}`);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(bodyText || "(no plain text body provided)");
    lines.push(`--${altBoundary}`);
    lines.push("Content-Type: text/html; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(bodyHtml);
    lines.push(`--${altBoundary}--`);
  } else {
    lines.push(`--${mixedBoundary}`);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(bodyText);
  }

  for (const attachment of attachments) {
    lines.push(`--${mixedBoundary}`);
    lines.push(`Content-Type: ${attachment.mimeType}; name=\"${attachment.filename}\"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push(`Content-Disposition: attachment; filename=\"${attachment.filename}\"`);
    lines.push("");
    lines.push(attachment.contentBase64.replace(/\s+/g, ""));
  }

  lines.push(`--${mixedBoundary}--`);
  return encodeBase64Url(lines.join("\r\n"));
}

/**
 * Register Gmail read tools: search_messages, get_message, list_threads, get_attachment
 * Phase 1 handles read-only operations.
 * Phase 2 will add send/modify tools (gated by write scope).
 */
export async function registerGmailTools(api: OpenClawPluginApi, config: GoogleWorkspaceConfig) {
  const createGmailService = async () => {
    const authClient = await createGoogleAuthClient(config);
    return new gmail_v1.Gmail({ auth: authClient });
  };

  api.registerTool(
    {
      name: "google_gmail",
      label: "Google Gmail",
      description:
        "Gmail operations. Read actions: search_messages, get_message, list_threads, get_attachment. Write actions (scopeProfile=write): send_message, modify_labels.",
      parameters: GmailSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as GmailParams;
        try {
          const gmail = await createGmailService();

          switch (p.action) {
            case "search_messages": {
              const res = await gmail.users.messages.list({
                userId: "me",
                q: p.query,
                maxResults: Math.min(p.maxResults ?? 10, 100),
                pageToken: p.pageToken,
              });

              return json({
                messages: res.data.messages?.map((m: gmail_v1.Schema$Message) => ({
                  id: m.id,
                  threadId: m.threadId,
                })) ?? [],
                nextPageToken: res.data.nextPageToken,
                resultSizeEstimate: res.data.resultSizeEstimate,
              });
            }

            case "get_message": {
              const res = await gmail.users.messages.get({
                userId: "me",
                id: p.messageId,
                format: p.format ?? "full",
              });

              return json({
                id: res.data.id,
                threadId: res.data.threadId,
                labelIds: res.data.labelIds,
                snippet: res.data.snippet,
                headers: res.data.payload?.headers,
                body: decodeBase64Url(res.data.payload?.body?.data),
                parts: res.data.payload?.parts?.map((part: gmail_v1.Schema$MessagePart) => ({
                  mimeType: part.mimeType,
                  filename: part.filename,
                  size: part.size,
                })),
              });
            }

            case "list_threads": {
              const res = await gmail.users.threads.list({
                userId: "me",
                q: p.query,
                maxResults: Math.min(p.maxResults ?? 10, 100),
                pageToken: p.pageToken,
              });

              return json({
                threads: res.data.threads?.map((t: gmail_v1.Schema$Thread) => ({
                  id: t.id,
                  historyId: t.historyId,
                })) ?? [],
                nextPageToken: res.data.nextPageToken,
                resultSizeEstimate: res.data.resultSizeEstimate,
              });
            }

            case "get_attachment": {
              const res = await gmail.users.messages.attachments.get({
                userId: "me",
                messageId: p.messageId,
                id: p.attachmentId,
              });

              const sizeBytes = parseInt(res.data.size ?? "0", 10);
              const maxBytes = (config.gmail.maxAttachmentMb ?? 20) * 1024 * 1024;

              if (sizeBytes > maxBytes) {
                return json({
                  error: `Attachment size (${sizeBytes} bytes) exceeds limit (${maxBytes} bytes)`,
                });
              }

              return json({
                mimeType: res.data.mimeType,
                size: res.data.size,
                filename: res.data.filename,
                data: res.data.data ? res.data.data.substring(0, 10000) : null, // Limit to first 10KB of data for logging safety
              });
            }

            case "send_message": {
              assertWriteScope(config);

              const recipients = allRecipients(p);
              enforceRecipientPolicy(config, recipients);

              if (!p.confirmSend || p.confirmationToken !== "SEND_EMAIL") {
                return json({
                  error: "confirmation_required",
                  message: "This action sends an external email and requires explicit confirmation.",
                  required: {
                    confirmSend: true,
                    confirmationToken: "SEND_EMAIL",
                  },
                  preview: {
                    to: p.to,
                    cc: p.cc ?? [],
                    bcc: p.bcc ?? [],
                    subject: p.subject,
                    attachmentCount: p.attachments?.length ?? 0,
                  },
                });
              }

              const raw = buildRawEmail(p);
              const res = await gmail.users.messages.send({
                userId: "me",
                requestBody: { raw },
              });

              return json({
                sent: true,
                id: res.data.id,
                threadId: res.data.threadId,
                labelIds: res.data.labelIds,
              });
            }

            case "modify_labels": {
              assertWriteScope(config);
              const add = p.addLabelIds ?? [];
              const remove = p.removeLabelIds ?? [];

              if (add.length === 0 && remove.length === 0) {
                return json({
                  error: "No label changes requested. Provide addLabelIds and/or removeLabelIds.",
                });
              }

              const res = await gmail.users.messages.modify({
                userId: "me",
                id: p.messageId,
                requestBody: {
                  addLabelIds: add,
                  removeLabelIds: remove,
                },
              });

              return json({
                updated: true,
                id: res.data.id,
                threadId: res.data.threadId,
                labelIds: res.data.labelIds,
              });
            }

            default:
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return json({ error: `Unknown Gmail action: ${(p as any).action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "google_gmail" },
  );

  api.logger?.info?.("google-workspace: Registered google_gmail tool");
}
