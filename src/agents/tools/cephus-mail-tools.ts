import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import {
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

const DEFAULT_TIMEOUT_MS = 15000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;

const ImapReadSchema = Type.Object({
  mailbox: Type.Optional(Type.String({ description: "Mailbox name (default: INBOX)." })),
  limit: Type.Optional(
    Type.Number({ description: "Max messages to fetch (default: 5, max: 20)." }),
  ),
  subject_query: Type.Optional(Type.String({ description: "Optional subject text filter." })),
  max_body_chars: Type.Optional(
    Type.Number({ description: "Preview body size in chars (default: 1200, max: 8000)." }),
  ),
});

const SmtpSendSchema = Type.Object({
  to: Type.Array(Type.String(), { minItems: 1, description: "Recipient email(s)." }),
  cc: Type.Optional(Type.Array(Type.String())),
  bcc: Type.Optional(Type.Array(Type.String())),
  subject: Type.String({ minLength: 1, description: "Email subject." }),
  body: Type.String({ minLength: 1, description: "Email body." }),
  reply_to: Type.Optional(Type.String({ description: "Optional reply-to email." })),
});

type BrokerRequest = {
  operation: "imap_read_emails" | "smtp_send_email";
  operationInput: Record<string, unknown>;
};

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

async function executeBrokerOperation(params: { config?: OpenClawConfig; request: BrokerRequest }) {
  const cephus = resolveCephusConfig(params.config);
  if (!cephus.enabled) {
    return jsonResult({
      status: "error",
      error_code: "CEPHUS_DISABLED",
      safe_message: "cephusOps is disabled in runtime config.",
      operation: params.request.operation,
    });
  }
  if (!cephus.baseUrl || !cephus.apiToken || !cephus.agentId) {
    return jsonResult({
      status: "error",
      error_code: "CEPHUS_CONFIG_MISSING",
      safe_message: "cephusOps.baseUrl, cephusOps.apiToken, and cephusOps.agentId are required.",
      operation: params.request.operation,
    });
  }

  const endpoint = `${cephus.baseUrl.replace(/\/$/, "")}/api/agents/${encodeURIComponent(cephus.agentId)}/credential_broker/execute`;
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
        operation: params.request.operation,
        operation_input: params.request.operationInput,
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
        payload && typeof payload === "object" && "error" in (payload as Record<string, unknown>)
          ? String((payload as Record<string, unknown>).error)
          : rawText.slice(0, 500) || `HTTP ${response.status}`;
      return jsonResult({
        status: "error",
        error_code: "BROKER_HTTP_ERROR",
        safe_message: message,
        operation: params.request.operation,
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
        error_code: "BROKER_INVALID_RESPONSE",
        safe_message: "Broker response did not include a valid data payload.",
        operation: params.request.operation,
      });
    }

    return jsonResult(data);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return jsonResult({
      status: "error",
      error_code: timedOut ? "BROKER_TIMEOUT" : "BROKER_REQUEST_FAILED",
      safe_message: timedOut
        ? `Broker request timed out after ${cephus.timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : String(error),
      operation: params.request.operation,
    });
  } finally {
    clearTimeout(timer);
  }
}

function validateEmailList(params: Record<string, unknown>, key: string): string[] | undefined {
  const values = readStringArrayParam(params, key);
  if (!values) {
    return undefined;
  }
  const invalid = values.find((entry) => !entry.includes("@"));
  if (invalid) {
    throw new ToolInputError(`${key} contains an invalid email address: ${invalid}`);
  }
  return values;
}

export function createImapReadEmailsTool(options?: { config?: OpenClawConfig }): AnyAgentTool {
  return {
    label: "Mail Inbox Read",
    name: "imap_read_emails",
    description:
      "Read recent inbox emails via Cephus secure credential broker when a mail_server binding is active.",
    parameters: ImapReadSchema,
    execute: async (_toolCallId, rawParams) => {
      const params =
        rawParams && typeof rawParams === "object" ? (rawParams as Record<string, unknown>) : {};
      const mailbox = readStringParam(params, "mailbox") ?? "INBOX";
      const limit = readNumberParam(params, "limit", { integer: true });
      const subjectQuery = readStringParam(params, "subject_query");
      const maxBodyChars = readNumberParam(params, "max_body_chars", { integer: true });

      const operationInput: Record<string, unknown> = { mailbox };
      if (typeof limit === "number") {
        operationInput.limit = limit;
      }
      if (subjectQuery) {
        operationInput.subject_query = subjectQuery;
      }
      if (typeof maxBodyChars === "number") {
        operationInput.max_body_chars = maxBodyChars;
      }

      return executeBrokerOperation({
        config: options?.config,
        request: {
          operation: "imap_read_emails",
          operationInput,
        },
      });
    },
  };
}

export function createSmtpSendEmailTool(options?: { config?: OpenClawConfig }): AnyAgentTool {
  return {
    label: "Mail Send",
    name: "smtp_send_email",
    description:
      "Send email via Cephus secure credential broker when a mail_server binding is active.",
    parameters: SmtpSendSchema,
    execute: async (_toolCallId, rawParams) => {
      const params =
        rawParams && typeof rawParams === "object" ? (rawParams as Record<string, unknown>) : {};
      const to = readStringArrayParam(params, "to", { required: true, label: "to" });
      const cc = validateEmailList(params, "cc");
      const bcc = validateEmailList(params, "bcc");
      const subject = readStringParam(params, "subject", { required: true });
      const body = readStringParam(params, "body", { required: true, allowEmpty: false });
      const replyTo = readStringParam(params, "reply_to");

      const invalidTo = to.find((entry) => !entry.includes("@"));
      if (invalidTo) {
        throw new ToolInputError(`to contains an invalid email address: ${invalidTo}`);
      }

      const operationInput: Record<string, unknown> = {
        to,
        subject,
        body,
      };
      if (cc && cc.length > 0) {
        operationInput.cc = cc;
      }
      if (bcc && bcc.length > 0) {
        operationInput.bcc = bcc;
      }
      if (replyTo) {
        operationInput.reply_to = replyTo;
      }

      return executeBrokerOperation({
        config: options?.config,
        request: {
          operation: "smtp_send_email",
          operationInput,
        },
      });
    },
  };
}
