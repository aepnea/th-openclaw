import { describe, expect, test } from "vitest";
import { adaptGmailPubSubEvent, buildGmailTriagePrompt } from "./gmail-pubsub-adapter.js";

describe("gmail pubsub adapter", () => {
  const eventDataBase64 = "eyJlbWFpbEFkZHJlc3MiOiJvcHNAZXhhbXBsZS5jb20iLCJoaXN0b3J5SWQiOiI5MDEifQ==";

  test("maps pubsub push envelope into tool context", () => {
    const envelope = {
      message: {
        messageId: "msg-1",
        attributes: { webhook_id: "webhook-123" },
        data: eventDataBase64,
      },
      subscription: "projects/test/subscriptions/gmail-events-sub",
    };

    const context = adaptGmailPubSubEvent(envelope);

    expect(context.emailAddress).toBe("ops@example.com");
    expect(context.historyId).toBe("901");
    expect(context.webhookId).toBe("webhook-123");
    expect(context.suggestedTool.name).toBe("google_gmail");
    expect(context.suggestedTool.action).toBe("search_messages");
  });

  test("builds triage prompt for hook dispatch", () => {
    const context = adaptGmailPubSubEvent({
      message: {
        data: eventDataBase64,
      },
    });

    const prompt = buildGmailTriagePrompt(context);

    expect(prompt).toContain("Perform inbox triage");
    expect(prompt).toContain("emailAddress=ops@example.com");
    expect(prompt).toContain("google_gmail");
  });

  test("rejects missing identifiers", () => {
    expect(() => adaptGmailPubSubEvent({ message: { data: "e30=" } })).toThrow(
      /missing required emailAddress\/historyId/,
    );
  });
});
