import { afterEach, describe, expect, it, vi } from "vitest";
import { createImapReadEmailsTool, createSmtpSendEmailTool } from "./cephus-mail-tools.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cephus mail tools", () => {
  it("returns config error when cephusOps is not fully configured", async () => {
    const tool = createImapReadEmailsTool({
      config: {
        cephusOps: {
          enabled: true,
          baseUrl: "https://cephus.example.com",
        },
      },
    });

    const result = await tool.execute("call-1", {});
    const details = result.details as Record<string, unknown>;

    expect(details.status).toBe("error");
    expect(details.error_code).toBe("CEPHUS_CONFIG_MISSING");
  });

  it("calls broker endpoint and returns data payload for imap_read_emails", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: {
            status: "ok",
            result: {
              provider: "imap",
              metadata: {
                fetched_count: 1,
                messages: [{ subject: "hello" }],
              },
            },
          },
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createImapReadEmailsTool({
      config: {
        cephusOps: {
          enabled: true,
          baseUrl: "https://cephus.example.com",
          apiToken: "token-1",
          agentId: "agt-123",
          timeoutMs: 4500,
        },
      },
    });

    const result = await tool.execute("call-2", {
      mailbox: "INBOX",
      limit: 3,
      subject_query: "invoice",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = firstCall;
    expect(url).toBe("https://cephus.example.com/api/agents/agt-123/credential_broker/execute");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer token-1",
    });

    expect(typeof init.body).toBe("string");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.operation).toBe("imap_read_emails");
    expect(body.operation_input).toMatchObject({
      mailbox: "INBOX",
      limit: 3,
      subject_query: "invoice",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("ok");
    expect(details.result).toMatchObject({ provider: "imap" });
  });

  it("returns timeout error when fetch aborts", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const err = new Error("aborted");
      err.name = "AbortError";
      if (init?.signal) {
        throw err;
      }
      return { ok: false, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createSmtpSendEmailTool({
      config: {
        cephusOps: {
          enabled: true,
          baseUrl: "https://cephus.example.com",
          apiToken: "token-2",
          agentId: "agt-456",
          timeoutMs: 1000,
        },
      },
    });

    const result = await tool.execute("call-3", {
      to: ["someone@example.com"],
      subject: "Hola",
      body: "Mensaje",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("error");
    expect(details.error_code).toBe("BROKER_TIMEOUT");
  });
});
