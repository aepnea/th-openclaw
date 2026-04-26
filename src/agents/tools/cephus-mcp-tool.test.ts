import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExecuteTool, createMcpReadResourceTool } from "./cephus-mcp-tool.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cephus mcp tool", () => {
  it("returns config error when cephusOps is not fully configured", async () => {
    const tool = createMcpExecuteTool({
      config: {
        cephusOps: {
          enabled: true,
          baseUrl: "https://cephus.example.com",
        },
      },
    });

    const result = await tool.execute("call-1", { tool_name: "health_check" });
    const details = result.details as Record<string, unknown>;

    expect(details.status).toBe("error");
    expect(details.error_code).toBe("CEPHUS_CONFIG_MISSING");
  });

  it("calls mcp broker endpoint and returns data payload", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: {
            status: "ok",
            tool_name: "health_check",
            result: {
              status: "ok",
            },
          },
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createMcpExecuteTool({
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
      tool_name: "health_check",
      arguments: { deep: true },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = firstCall;

    expect(url).toBe("https://cephus.example.com/api/agents/agt-123/mcp_broker/execute");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer token-1",
    });

    expect(typeof init.body).toBe("string");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.tool_name).toBe("health_check");
    expect(body.arguments).toMatchObject({ deep: true });

    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("ok");
    expect(details.tool_name).toBe("health_check");
  });

  it("returns config error for mcp_read_resource when cephusOps is not fully configured", async () => {
    const tool = createMcpReadResourceTool({
      config: {
        cephusOps: {
          enabled: true,
          baseUrl: "https://cephus.example.com",
        },
      },
    });

    const result = await tool.execute("call-3", { resource_uri: "email://capabilities" });
    const details = result.details as Record<string, unknown>;

    expect(details.status).toBe("error");
    expect(details.error_code).toBe("CEPHUS_CONFIG_MISSING");
  });

  it("calls mcp broker read_resource endpoint and returns data payload", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: {
            status: "ok",
            resource_uri: "email://capabilities",
            result: {
              content: [{ type: "text", text: '{"ok":true}' }],
            },
          },
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createMcpReadResourceTool({
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

    const result = await tool.execute("call-4", {
      resource_uri: "email://capabilities",
      arguments: { format: "json" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = firstCall;

    expect(url).toBe("https://cephus.example.com/api/agents/agt-123/mcp_broker/read_resource");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer token-1",
    });

    expect(typeof init.body).toBe("string");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.resource_uri).toBe("email://capabilities");
    expect(body.arguments).toMatchObject({ format: "json" });

    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("ok");
    expect(details.resource_uri).toBe("email://capabilities");
  });
});
