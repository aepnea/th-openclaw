import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../registry.js";
import { registerCephusBudgetThresholdHooks } from "./cephus-budget-threshold.js";

describe("registerCephusBudgetThresholdHooks", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const enabledConfig: OpenClawConfig = {
    cephusOps: {
      enabled: true,
      baseUrl: "https://cephus.example.com",
      agentId: "agent-123",
      apiToken: "token-1",
    },
  };

  const disabledConfig: OpenClawConfig = {
    cephusOps: {
      enabled: false,
      baseUrl: "https://cephus.example.com",
      agentId: "agent-123",
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers both hooks when cephusOps.enabled=true", () => {
    const registry = createEmptyPluginRegistry();

    registerCephusBudgetThresholdHooks(registry, enabledConfig, logger);

    const hookNames = registry.typedHooks.map((hook) => hook.hookName);
    expect(hookNames).toContain("before_tool_call");
    expect(hookNames).toContain("after_tool_call");
  });

  it("does not register hooks when cephusOps.enabled=false", () => {
    const registry = createEmptyPluginRegistry();

    registerCephusBudgetThresholdHooks(registry, disabledConfig, logger);

    expect(registry.typedHooks).toHaveLength(0);
  });

  it("is idempotent on repeated registration against same registry", () => {
    const registry = createEmptyPluginRegistry();

    registerCephusBudgetThresholdHooks(registry, enabledConfig, logger);
    registerCephusBudgetThresholdHooks(registry, enabledConfig, logger);

    const beforeHooks = registry.typedHooks.filter(
      (entry) => entry.hookName === "before_tool_call",
    );
    const afterHooks = registry.typedHooks.filter((entry) => entry.hookName === "after_tool_call");
    expect(beforeHooks).toHaveLength(1);
    expect(afterHooks).toHaveLength(1);
  });

  it("sends memory context in pre_action and post_action payloads", async () => {
    const registry = createEmptyPluginRegistry();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/operational_memories/snapshot")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              agent: [],
              global: [
                {
                  id: "g-1",
                  memory_scope: "global",
                  owner_user_id: "42",
                  memory_type: "preference",
                  confidence: 0.9,
                  content: "Usar tono directo",
                },
              ],
              resolved: [
                {
                  id: "g-1",
                  memory_scope: "global",
                  owner_user_id: "42",
                  memory_type: "preference",
                  confidence: 0.9,
                  content: "Usar tono directo",
                },
              ],
            },
          }),
        };
      }

      expect(init?.method).toBe("POST");
      return {
        ok: true,
        json: async () => ({ data: { decision: "allow" } }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    registerCephusBudgetThresholdHooks(registry, enabledConfig, logger);

    const beforeHook = registry.typedHooks.find((entry) => entry.hookName === "before_tool_call");
    const afterHook = registry.typedHooks.find((entry) => entry.hookName === "after_tool_call");
    expect(beforeHook).toBeDefined();
    expect(afterHook).toBeDefined();

    await beforeHook!.handler(
      {
        toolName: "memory_search",
        params: {
          _policy_context: {
            memory_scope: "global",
            owner_user_id: "42",
            agent_id: "agent-123",
          },
        },
      },
      { toolName: "memory_search", sessionKey: "session-1", agentId: "agent-123" },
    );

    await afterHook!.handler(
      {
        toolName: "memory_search",
        params: {
          _policy_context: {
            memory_scope: "agent",
            owner_user_id: "42",
            agent_id: "agent-123",
          },
        },
      },
      { toolName: "memory_search", sessionKey: "session-1", agentId: "agent-123" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const preActionCall = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).includes("/policy/pre_action"),
    );
    const postActionCall = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).includes("/policy/post_action"),
    );
    expect(preActionCall).toBeDefined();
    expect(postActionCall).toBeDefined();

    const firstPayload = JSON.parse(preActionCall![1].body as string);
    const secondPayload = JSON.parse(postActionCall![1].body as string);
    expect(firstPayload.context).toMatchObject({
      memory_scope: "global",
      owner_user_id: "42",
      agent_id: "agent-123",
    });
    expect(firstPayload.context.memory_snapshot.counts).toMatchObject({
      agent: 0,
      global: 1,
      resolved: 1,
    });
    expect(secondPayload.context).toMatchObject({
      memory_scope: "agent",
      owner_user_id: "42",
      agent_id: "agent-123",
    });
    expect(typeof secondPayload.external_ref).toBe("string");
    expect(secondPayload.external_ref).toMatch(/^cephus:[a-f0-9]{64}$/);
  });

  it("applies degrade_actions directly to tool params", async () => {
    const registry = createEmptyPluginRegistry();
    const fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/operational_memories/snapshot")) {
        return {
          ok: true,
          json: async () => ({ data: { agent: [], global: [], resolved: [] } }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            decision: "degrade",
            trace_id: "trace-1",
            degrade_actions: [
              { action: "model_downgrade" },
              { action: "retrieval_cap", max_results: 3 },
              { action: "memory_clamp", max_items: 2 },
            ],
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    registerCephusBudgetThresholdHooks(registry, enabledConfig, logger);

    const beforeHook = registry.typedHooks.find((entry) => entry.hookName === "before_tool_call");
    expect(beforeHook).toBeDefined();

    const result = await beforeHook!.handler(
      {
        toolName: "memory_search",
        params: {
          query: "hola",
          maxResults: 10,
        },
      },
      { toolName: "memory_search", sessionKey: "session-2", agentId: "agent-123" },
    );

    expect(result).toBeDefined();
    const params = result ? (result.params as Record<string, unknown>) : undefined;
    expect(params).toMatchObject({
      modelProfile: "cost_saver",
      maxResults: 3,
      maxItems: 2,
    });
    expect(params?._degrade_applied).toBeDefined();
  });

  it("dedupes post_action telemetry in-session with stable external_ref", async () => {
    const registry = createEmptyPluginRegistry();
    const fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/operational_memories/snapshot")) {
        return {
          ok: true,
          json: async () => ({ data: { agent: [], global: [], resolved: [] } }),
        };
      }
      return {
        ok: true,
        json: async () => ({ data: { decision: "allow" } }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    registerCephusBudgetThresholdHooks(registry, enabledConfig, logger);

    const afterHook = registry.typedHooks.find((entry) => entry.hookName === "after_tool_call");
    expect(afterHook).toBeDefined();

    const event = {
      toolName: "memory_search",
      params: {
        query: "hola",
        _round_index: 7,
      },
    };

    await afterHook!.handler(event, {
      toolName: "memory_search",
      sessionKey: "session-dedupe",
      agentId: "agent-123",
    });
    await afterHook!.handler(event, {
      toolName: "memory_search",
      sessionKey: "session-dedupe",
      agentId: "agent-123",
    });

    const postCalls = fetchMock.mock.calls.filter((entry) =>
      String(entry[0]).includes("/policy/post_action"),
    );
    expect(postCalls).toHaveLength(1);
    const payload = JSON.parse(postCalls[0][1].body as string);
    expect(payload.external_ref).toMatch(/^cephus:[a-f0-9]{64}$/);
  });

  it("memoizes snapshot per session and enriches context", async () => {
    const registry = createEmptyPluginRegistry();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/operational_memories/snapshot")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              agent: [{ id: "a-1", memory_scope: "agent", owner_user_id: "42", content: "A" }],
              global: [{ id: "g-1", memory_scope: "global", owner_user_id: "42", content: "G" }],
              resolved: [{ id: "a-1", memory_scope: "agent", owner_user_id: "42", content: "A" }],
            },
          }),
        };
      }
      expect(init?.method).toBe("POST");
      return {
        ok: true,
        json: async () => ({ data: { decision: "allow" } }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    registerCephusBudgetThresholdHooks(registry, enabledConfig, logger);

    const beforeHook = registry.typedHooks.find((entry) => entry.hookName === "before_tool_call");
    expect(beforeHook).toBeDefined();

    await beforeHook!.handler(
      {
        toolName: "memory_search",
        params: { query: "q1" },
      },
      { toolName: "memory_search", sessionKey: "snapshot-cache-session", agentId: "agent-123" },
    );
    await beforeHook!.handler(
      {
        toolName: "memory_search",
        params: { query: "q2" },
      },
      { toolName: "memory_search", sessionKey: "snapshot-cache-session", agentId: "agent-123" },
    );

    const snapshotCalls = fetchMock.mock.calls.filter((entry) =>
      String(entry[0]).includes("/api/operational_memories/snapshot"),
    );
    expect(snapshotCalls).toHaveLength(1);

    const preActionCall = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).includes("/policy/pre_action"),
    );
    expect(preActionCall).toBeDefined();
    const payload = JSON.parse(preActionCall![1].body as string);
    expect(payload.context).toMatchObject({
      memory_scope: "agent",
      owner_user_id: "42",
      agent_id: "agent-123",
    });
    expect(payload.context.memory_snapshot.counts).toMatchObject({
      agent: 1,
      global: 1,
      resolved: 1,
    });
  });

  it("falls back safely when snapshot endpoint is unavailable", async () => {
    const registry = createEmptyPluginRegistry();
    const fetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/operational_memories/snapshot")) {
        return {
          ok: false,
          json: async () => ({ error: "unavailable" }),
        };
      }
      return {
        ok: true,
        json: async () => ({ data: { decision: "allow" } }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    registerCephusBudgetThresholdHooks(registry, enabledConfig, logger);

    const beforeHook = registry.typedHooks.find((entry) => entry.hookName === "before_tool_call");
    expect(beforeHook).toBeDefined();

    const result = await beforeHook!.handler(
      {
        toolName: "memory_search",
        params: {
          query: "fallback",
          _policy_context: {
            memory_scope: "global",
            owner_user_id: "42",
            agent_id: "agent-123",
          },
        },
      },
      { toolName: "memory_search", sessionKey: "snapshot-fallback", agentId: "agent-123" },
    );

    expect(result).toBeDefined();
    expect(result?.params?._policy_context).toMatchObject({
      memory_scope: "global",
      owner_user_id: "42",
      agent_id: "agent-123",
    });
  });
});
