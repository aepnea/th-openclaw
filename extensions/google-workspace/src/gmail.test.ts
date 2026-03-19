import { describe, test, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerGmailTools } from "./gmail.js";
import type { GoogleWorkspaceConfig } from "./config-schema.js";

const mockMessagesList = vi.fn();
const mockMessagesSend = vi.fn();
const mockMessagesModify = vi.fn();
const mockAttachmentsGet = vi.fn();

const mockGmailService = {
  users: {
    messages: {
      list: mockMessagesList,
      send: mockMessagesSend,
      modify: mockMessagesModify,
      attachments: {
        get: mockAttachmentsGet,
      },
    },
    threads: {
      list: vi.fn(),
    },
  },
};

// Mock googleapis
vi.mock("googleapis", () => ({
  gmail_v1: {
    Gmail: vi.fn(() => mockGmailService),
  },
}));

vi.mock("./auth.js", () => ({
  createGoogleAuthClient: vi.fn().mockResolvedValue({}),
}));

describe("Gmail tools", () => {
  let mockApi: Partial<OpenClawPluginApi>;
  let registerToolFn: any;

  beforeEach(() => {
    registerToolFn = vi.fn();
    mockMessagesList.mockReset();
    mockMessagesSend.mockReset();
    mockMessagesModify.mockReset();
    mockAttachmentsGet.mockReset();
    mockApi = {
      registerTool: registerToolFn,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  });

  test("should register gmail tool", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "read",
      gmail: { maxAttachmentMb: 20 },
    };

    await registerGmailTools(mockApi as OpenClawPluginApi, config);

    expect(registerToolFn).toHaveBeenCalled();
    const toolDef = registerToolFn.mock.calls[0][0];

    expect(toolDef.name).toBe("google_gmail");
    expect(toolDef.label).toBe("Google Gmail");
    expect(toolDef.description).toContain("search_messages");
    expect(toolDef.execute).toBeDefined();
  });

  test("should handle search_messages action", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "read",
    };

    await registerGmailTools(mockApi as OpenClawPluginApi, config);

    const toolDef = registerToolFn.mock.calls[0][0];

    mockMessagesList.mockResolvedValue({
      data: {
        messages: [{ id: "msg1", threadId: "th1" }],
        resultSizeEstimate: 1,
      },
    });

    const result = await toolDef.execute("tool-call-1", {
      action: "search_messages",
      query: "from:test@example.com",
    });

    expect(result.details.messages).toHaveLength(1);
    expect(result.details.messages[0].id).toBe("msg1");
    expect(mockMessagesList).toHaveBeenCalled();
  });

  test("should block send_message when scopeProfile is read", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "read",
    };

    await registerGmailTools(mockApi as OpenClawPluginApi, config);
    const toolDef = registerToolFn.mock.calls[0][0];

    const result = await toolDef.execute("tool-call-2", {
      action: "send_message",
      to: ["alice@example.com"],
      subject: "Hello",
      bodyText: "Hi",
      confirmSend: true,
      confirmationToken: "SEND_EMAIL",
    });

    expect(result.details.error).toContain("scopeProfile=write");
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });

  test("should require confirmation for send_message", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "write",
    };

    await registerGmailTools(mockApi as OpenClawPluginApi, config);
    const toolDef = registerToolFn.mock.calls[0][0];

    const result = await toolDef.execute("tool-call-3", {
      action: "send_message",
      to: ["alice@example.com"],
      subject: "Needs confirmation",
      bodyText: "Hi",
      confirmSend: false,
    });

    expect(result.details.error).toBe("confirmation_required");
    expect(result.details.required.confirmationToken).toBe("SEND_EMAIL");
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });

  test("should enforce recipient domain allowlist", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "write",
      gmail: {
        maxAttachmentMb: 20,
        allowedRecipientDomains: ["company.com"],
      },
    };

    await registerGmailTools(mockApi as OpenClawPluginApi, config);
    const toolDef = registerToolFn.mock.calls[0][0];

    const result = await toolDef.execute("tool-call-4", {
      action: "send_message",
      to: ["alice@external.com"],
      subject: "Policy check",
      bodyText: "Hi",
      confirmSend: true,
      confirmationToken: "SEND_EMAIL",
    });

    expect(result.details.error).toContain("Recipients not allowed by policy");
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });

  test("should send message when confirmation is valid and scope is write", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "write",
    };

    mockMessagesSend.mockResolvedValue({
      data: {
        id: "sent-123",
        threadId: "thread-123",
        labelIds: ["SENT"],
      },
    });

    await registerGmailTools(mockApi as OpenClawPluginApi, config);
    const toolDef = registerToolFn.mock.calls[0][0];

    const result = await toolDef.execute("tool-call-5", {
      action: "send_message",
      to: ["alice@example.com"],
      subject: "Approved",
      bodyText: "Hello",
      confirmSend: true,
      confirmationToken: "SEND_EMAIL",
    });

    expect(result.details.sent).toBe(true);
    expect(result.details.id).toBe("sent-123");
    expect(mockMessagesSend).toHaveBeenCalled();
  });

  test("should block modify_labels when scopeProfile is read", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "read",
    };

    await registerGmailTools(mockApi as OpenClawPluginApi, config);
    const toolDef = registerToolFn.mock.calls[0][0];

    const result = await toolDef.execute("tool-call-6", {
      action: "modify_labels",
      messageId: "msg-1",
      addLabelIds: ["STARRED"],
    });

    expect(result.details.error).toContain("scopeProfile=write");
    expect(mockMessagesModify).not.toHaveBeenCalled();
  });

  test("should modify labels when scopeProfile is write", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "write",
    };

    mockMessagesModify.mockResolvedValue({
      data: {
        id: "msg-1",
        threadId: "thread-1",
        labelIds: ["INBOX", "STARRED"],
      },
    });

    await registerGmailTools(mockApi as OpenClawPluginApi, config);
    const toolDef = registerToolFn.mock.calls[0][0];

    const result = await toolDef.execute("tool-call-7", {
      action: "modify_labels",
      messageId: "msg-1",
      addLabelIds: ["STARRED"],
      removeLabelIds: ["UNREAD"],
    });

    expect(result.details.updated).toBe(true);
    expect(result.details.id).toBe("msg-1");
    expect(mockMessagesModify).toHaveBeenCalled();
  });
});
