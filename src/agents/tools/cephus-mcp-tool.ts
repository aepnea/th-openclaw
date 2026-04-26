import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { jsonResult, readStringParam, ToolInputError, type AnyAgentTool } from "./common.js";

const DEFAULT_TIMEOUT_MS = 20000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;

const McpExecuteToolSchema = Type.Object({
  tool_name: Type.String({ minLength: 1, description: "MCP tool name to execute." }),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "JSON object passed as MCP tool arguments.",
    }),
  ),
});

const McpReadResourceSchema = Type.Object({
  resource_uri: Type.String({ minLength: 1, description: "MCP resource URI to read." }),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Optional JSON object passed as resource read arguments.",
    }),
  ),
});

function resolveCephusConfig(config?: OpenClawConfig) {
  const cephus = config?.cephusOps;
  const enabled = cephus?.enabled !== false;
  const baseUrl = cephus?.baseUrl?.trim() ?? "";
  const apiToken = cephus?.apiToken?.trim() ?? "";
  const agentId = cephus?.agentId?.trim() ?? "";
  const timeoutRaw = typeof cephus?.timeoutMs === "number" ? cephus.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(timeoutRaw)));
  return { enabled, baseUrl, apiToken, agentId, timeoutMs };
}

export function createMcpExecuteTool(options?: { config?: OpenClawConfig }): AnyAgentTool {
  return {
    label: "MCP Execute",
    name: "mcp_execute_tool",
    description:
      "Execute a bound MCP tool through Cephus MCP broker. Pass the MCP tool name in tool_name and parameters in arguments.",
    parameters: McpExecuteToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const params =
        rawParams && typeof rawParams === "object" ? (rawParams as Record<string, unknown>) : {};
      const toolName = readStringParam(params, "tool_name", { required: true, allowEmpty: false });
      const args = params.arguments;
      if (
        args !== undefined &&
        (typeof args !== "object" || args === null || Array.isArray(args))
      ) {
        throw new ToolInputError("arguments must be an object when provided.");
      }

      const cephus = resolveCephusConfig(options?.config);
      if (!cephus.enabled) {
        return jsonResult({
          status: "error",
          error_code: "CEPHUS_DISABLED",
          safe_message: "cephusOps is disabled in runtime config.",
          tool_name: toolName,
        });
      }
      if (!cephus.baseUrl || !cephus.apiToken || !cephus.agentId) {
        return jsonResult({
          status: "error",
          error_code: "CEPHUS_CONFIG_MISSING",
          safe_message:
            "cephusOps.baseUrl, cephusOps.apiToken, and cephusOps.agentId are required.",
          tool_name: toolName,
        });
      }

      const endpoint = `${cephus.baseUrl.replace(/\/$/, "")}/api/agents/${encodeURIComponent(cephus.agentId)}/mcp_broker/execute`;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), cephus.timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cephus.apiToken}`,
          },
          body: JSON.stringify({
            tool_name: toolName,
            arguments: (args as Record<string, unknown> | undefined) ?? {},
          }),
          signal: abort.signal,
        });

        const rawText = await response.text();
        let payload: unknown;
        try {
          payload = rawText ? (JSON.parse(rawText) as unknown) : null;
        } catch {
          payload = null;
        }

        if (!response.ok) {
          const message =
            payload &&
            typeof payload === "object" &&
            "error" in (payload as Record<string, unknown>)
              ? String((payload as Record<string, unknown>).error)
              : rawText.slice(0, 500) || `HTTP ${response.status}`;

          return jsonResult({
            status: "error",
            error_code: "MCP_BROKER_HTTP_ERROR",
            safe_message: message,
            tool_name: toolName,
            http_status: response.status,
          });
        }

        const data =
          payload && typeof payload === "object" && "data" in (payload as Record<string, unknown>)
            ? (payload as Record<string, unknown>).data
            : payload;

        if (!data || typeof data !== "object") {
          return jsonResult({
            status: "error",
            error_code: "MCP_BROKER_INVALID_RESPONSE",
            safe_message: "MCP broker response did not include a valid data payload.",
            tool_name: toolName,
          });
        }

        return jsonResult(data);
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        return jsonResult({
          status: "error",
          error_code: timedOut ? "MCP_BROKER_TIMEOUT" : "MCP_BROKER_REQUEST_FAILED",
          safe_message: timedOut
            ? `MCP broker request timed out after ${cephus.timeoutMs}ms.`
            : error instanceof Error
              ? error.message
              : String(error),
          tool_name: toolName,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createMcpReadResourceTool(options?: { config?: OpenClawConfig }): AnyAgentTool {
  return {
    label: "MCP Read Resource",
    name: "mcp_read_resource",
    description:
      "Read a bound MCP resource through Cephus MCP broker. Pass the resource URI in resource_uri and optional parameters in arguments.",
    parameters: McpReadResourceSchema,
    execute: async (_toolCallId, rawParams) => {
      const params =
        rawParams && typeof rawParams === "object" ? (rawParams as Record<string, unknown>) : {};
      const resourceUri = readStringParam(params, "resource_uri", {
        required: true,
        allowEmpty: false,
      });
      const args = params.arguments;
      if (
        args !== undefined &&
        (typeof args !== "object" || args === null || Array.isArray(args))
      ) {
        throw new ToolInputError("arguments must be an object when provided.");
      }

      const cephus = resolveCephusConfig(options?.config);
      if (!cephus.enabled) {
        return jsonResult({
          status: "error",
          error_code: "CEPHUS_DISABLED",
          safe_message: "cephusOps is disabled in runtime config.",
          resource_uri: resourceUri,
        });
      }
      if (!cephus.baseUrl || !cephus.apiToken || !cephus.agentId) {
        return jsonResult({
          status: "error",
          error_code: "CEPHUS_CONFIG_MISSING",
          safe_message:
            "cephusOps.baseUrl, cephusOps.apiToken, and cephusOps.agentId are required.",
          resource_uri: resourceUri,
        });
      }

      const endpoint = `${cephus.baseUrl.replace(/\/$/, "")}/api/agents/${encodeURIComponent(cephus.agentId)}/mcp_broker/read_resource`;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), cephus.timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cephus.apiToken}`,
          },
          body: JSON.stringify({
            resource_uri: resourceUri,
            arguments: (args as Record<string, unknown> | undefined) ?? {},
          }),
          signal: abort.signal,
        });

        const rawText = await response.text();
        let payload: unknown;
        try {
          payload = rawText ? (JSON.parse(rawText) as unknown) : null;
        } catch {
          payload = null;
        }

        if (!response.ok) {
          const message =
            payload &&
            typeof payload === "object" &&
            "error" in (payload as Record<string, unknown>)
              ? String((payload as Record<string, unknown>).error)
              : rawText.slice(0, 500) || `HTTP ${response.status}`;

          return jsonResult({
            status: "error",
            error_code: "MCP_BROKER_HTTP_ERROR",
            safe_message: message,
            resource_uri: resourceUri,
            http_status: response.status,
          });
        }

        const data =
          payload && typeof payload === "object" && "data" in (payload as Record<string, unknown>)
            ? (payload as Record<string, unknown>).data
            : payload;

        if (!data || typeof data !== "object") {
          return jsonResult({
            status: "error",
            error_code: "MCP_BROKER_INVALID_RESPONSE",
            safe_message: "MCP broker response did not include a valid data payload.",
            resource_uri: resourceUri,
          });
        }

        return jsonResult(data);
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        return jsonResult({
          status: "error",
          error_code: timedOut ? "MCP_BROKER_TIMEOUT" : "MCP_BROKER_REQUEST_FAILED",
          safe_message: timedOut
            ? `MCP broker request timed out after ${cephus.timeoutMs}ms.`
            : error instanceof Error
              ? error.message
              : String(error),
          resource_uri: resourceUri,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
