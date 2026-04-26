import { describe, expect, it, vi } from "vitest";
import { deliverReplies } from "./replies.js";

const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));

const hookRunnerMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageSent: vi.fn(async () => {}),
  },
}));

const sendSlackMocks = vi.hoisted(() => ({
  sendMessageSlack: vi.fn(),
}));

vi.mock("../../hooks/internal-hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/internal-hooks.js")>();
  return {
    ...actual,
    createInternalHookEvent: internalHookMocks.createInternalHookEvent,
    triggerInternalHook: internalHookMocks.triggerInternalHook,
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => hookRunnerMocks.runner),
}));

vi.mock("../send.js", () => ({
  sendMessageSlack: sendSlackMocks.sendMessageSlack,
}));

describe("deliverReplies", () => {
  it("emits a single message.sent success event after delivery", async () => {
    internalHookMocks.createInternalHookEvent.mockImplementation(
      (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
        type,
        action,
        sessionKey,
        context,
        timestamp: new Date(),
        messages: [],
      }),
    );
    hookRunnerMocks.runner.hasHooks.mockReturnValue(true);
    sendSlackMocks.sendMessageSlack.mockResolvedValue({ messageId: "ts-1", channelId: "C1" });

    await deliverReplies({
      replies: [{ text: "done" }],
      target: "channel:C1",
      token: "xoxb-1",
      accountId: "slack-1",
      sessionKey: "agent:main:slack:channel:C1",
      runtime: {},
      textLimit: 4000,
    });

    expect(hookRunnerMocks.runner.runMessageSent).toHaveBeenCalledWith(
      {
        to: "channel:C1",
        content: "done",
        success: true,
      },
      {
        channelId: "slack",
        accountId: "slack-1",
        conversationId: "channel:C1",
      },
    );
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "agent:main:slack:channel:C1",
      expect.objectContaining({
        to: "channel:C1",
        content: "done",
        success: true,
        channelId: "slack",
        accountId: "slack-1",
        conversationId: "channel:C1",
        messageId: "ts-1",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("emits a failed message.sent event when Slack send errors", async () => {
    internalHookMocks.createInternalHookEvent.mockImplementation(
      (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
        type,
        action,
        sessionKey,
        context,
        timestamp: new Date(),
        messages: [],
      }),
    );
    hookRunnerMocks.runner.hasHooks.mockReturnValue(true);
    sendSlackMocks.sendMessageSlack.mockRejectedValue(new Error("slack down"));

    await expect(
      deliverReplies({
        replies: [{ text: "done" }],
        target: "channel:C1",
        token: "xoxb-1",
        accountId: "slack-1",
        sessionKey: "agent:main:slack:channel:C1",
        runtime: {},
        textLimit: 4000,
      }),
    ).rejects.toThrow("slack down");

    expect(hookRunnerMocks.runner.runMessageSent).toHaveBeenCalledWith(
      {
        to: "channel:C1",
        content: "done",
        success: false,
        error: "slack down",
      },
      {
        channelId: "slack",
        accountId: "slack-1",
        conversationId: "channel:C1",
      },
    );
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "agent:main:slack:channel:C1",
      expect.objectContaining({
        to: "channel:C1",
        content: "done",
        success: false,
        error: "slack down",
        channelId: "slack",
        accountId: "slack-1",
        conversationId: "channel:C1",
      }),
    );
  });
});
