import { Type, type Static } from "@sinclair/typebox";

/**
 * Gmail tool parameters schema using TypeBox.
 * Supports actions: search_messages, get_message, list_threads, get_attachment,
 * send_message, modify_labels.
 */
export const GmailSchema = Type.Union([
  // Search and list messages
  Type.Object(
    {
      action: Type.Literal("search_messages"),
      query: Type.String({
        description:
          "Gmail search query (e.g., 'from:someone@example.com', 'subject:hello', 'is:unread')",
      }),
      maxResults: Type.Optional(Type.Number({ description: "Max results (1-100, default 10)" })),
      pageToken: Type.Optional(Type.String({ description: "Pagination token from previous response" })),
    },
    { description: "Search for messages in Gmail" },
  ),

  // Get a specific message
  Type.Object(
    {
      action: Type.Literal("get_message"),
      messageId: Type.String({ description: "Message ID from search results" }),
      format: Type.Optional(
        Type.Union(
          [
            Type.Literal("full"),
            Type.Literal("minimal"),
            Type.Literal("raw"),
            Type.Literal("metadata"),
          ],
          { description: "Response format (default: full)" },
        ),
      ),
    },
    { description: "Retrieve full details of a specific message" },
  ),

  // List threads (conversations)
  Type.Object(
    {
      action: Type.Literal("list_threads"),
      query: Type.Optional(Type.String({ description: "Optional search query to filter threads" })),
      maxResults: Type.Optional(Type.Number({ description: "Max results (1-100, default 10)" })),
      pageToken: Type.Optional(Type.String({ description: "Pagination token from previous response" })),
    },
    { description: "List email threads/conversations" },
  ),

  // Get attachment from a message
  Type.Object(
    {
      action: Type.Literal("get_attachment"),
      messageId: Type.String({ description: "Message ID containing the attachment" }),
      attachmentId: Type.String({ description: "Attachment ID" }),
    },
    { description: "Download an attachment (limited by maxAttachmentMb config)" },
  ),

  // Send message (write scope required + explicit confirmation gate)
  Type.Object(
    {
      action: Type.Literal("send_message"),
      to: Type.Array(Type.String({ description: "Recipient email" }), {
        minItems: 1,
        description: "One or more recipient emails",
      }),
      cc: Type.Optional(Type.Array(Type.String({ description: "CC recipient email" }))),
      bcc: Type.Optional(Type.Array(Type.String({ description: "BCC recipient email" }))),
      subject: Type.String({ description: "Email subject" }),
      bodyText: Type.Optional(Type.String({ description: "Plain text email body" })),
      bodyHtml: Type.Optional(Type.String({ description: "HTML email body" })),
      attachments: Type.Optional(
        Type.Array(
          Type.Object({
            filename: Type.String({ description: "Attachment filename" }),
            mimeType: Type.String({ description: "Attachment MIME type" }),
            contentBase64: Type.String({ description: "Attachment content as base64 string" }),
          }),
        ),
      ),
      confirmSend: Type.Optional(
        Type.Boolean({
          description: "Must be true to actually send. If false, returns confirmation_required payload.",
        }),
      ),
      confirmationToken: Type.Optional(
        Type.String({ description: "Must be exactly 'SEND_EMAIL' when confirmSend=true" }),
      ),
    },
    { description: "Send a Gmail message (requires scopeProfile=write and explicit confirmation)" },
  ),

  // Modify labels (write scope required)
  Type.Object(
    {
      action: Type.Literal("modify_labels"),
      messageId: Type.String({ description: "Message ID to modify" }),
      addLabelIds: Type.Optional(
        Type.Array(Type.String({ description: "Label ID to add (e.g., STARRED, Label_123)" })),
      ),
      removeLabelIds: Type.Optional(
        Type.Array(Type.String({ description: "Label ID to remove" })),
      ),
    },
    { description: "Add/remove labels from a Gmail message (requires scopeProfile=write)" },
  ),
]);

export type GmailParams = Static<typeof GmailSchema>;
