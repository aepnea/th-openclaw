import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { CliDeps } from "../cli/deps.js";
import { loadConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { appendCronRunLog, resolveCronRunLogPath } from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronStorePath } from "../cron/store.js";
import { normalizeHttpWebhookUrl } from "../cron/webhook-url.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";

export type GatewayCronState = {
  cron: CronService;
  storePath: string;
  cronEnabled: boolean;
};

const CRON_WEBHOOK_TIMEOUT_MS = 10_000;
const FACTORY_SYNC_TIMEOUT_MS = 8_000;

type FactorySyncConfig = {
  baseUrl: string;
  apiToken: string;
  agentId: string;
};

function resolveFactorySyncConfig(cephusOps?: {
  enabled?: boolean;
  baseUrl?: string;
  apiToken?: string;
  agentId?: string;
}): FactorySyncConfig | null {
  if (!cephusOps?.enabled || !cephusOps.baseUrl || !cephusOps.apiToken || !cephusOps.agentId) {
    return null;
  }
  return {
    baseUrl: cephusOps.baseUrl.replace(/\/$/, ""),
    apiToken: cephusOps.apiToken,
    agentId: cephusOps.agentId,
  };
}

function mapCronJobToFactoryParams(job: import("../cron/types.js").CronJob) {
  const base: Record<string, unknown> = {
    openclaw_job_id: job.id,
    task_label: job.name,
    payload_message: job.payload.kind === "agentTurn" ? job.payload.message : job.name,
    active: job.enabled,
    delete_after_run: job.deleteAfterRun ?? false,
    channel: "playground",
  };

  const s = job.schedule;
  switch (s.kind) {
    case "cron":
      base.schedule_type = "cron";
      base.cron_expr = s.expr;
      base.timezone = s.tz ?? "UTC";
      break;
    case "at":
      base.schedule_type = "at";
      base.run_at = s.at;
      base.timezone = "UTC";
      break;
    case "every":
      base.schedule_type = "every";
      base.every_seconds = Math.round(s.everyMs / 1000);
      base.timezone = "UTC";
      break;
  }

  return base;
}

async function syncCronEventToFactory(params: {
  action: "added" | "updated" | "removed";
  jobId: string;
  job?: import("../cron/types.js").CronJob;
  syncCfg: FactorySyncConfig;
  log: import("../cron/service/state.js").Logger;
}) {
  const { action, jobId, job, syncCfg, log } = params;
  const tasksUrl = `${syncCfg.baseUrl}/api/agents/${encodeURIComponent(syncCfg.agentId)}/scheduled_tasks`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Factory-Token": syncCfg.apiToken,
  };

  try {
    if (action === "added" && job) {
      const body = { scheduled_task: mapCronJobToFactoryParams(job) };
      const res = await fetchWithSsrFGuard({
        url: tasksUrl,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(FACTORY_SYNC_TIMEOUT_MS),
        },
      });
      await res.response.body?.cancel();
      await res.release();
      log.info({ jobId, action }, "factory-sync: task created");
    } else if (action === "updated" && job) {
      // Find existing task by openclaw_job_id, then PATCH
      const listRes = await fetchWithSsrFGuard({
        url: tasksUrl,
        init: { method: "GET", headers, signal: AbortSignal.timeout(FACTORY_SYNC_TIMEOUT_MS) },
      });
      const listBody = (await listRes.response.json()) as {
        scheduled_tasks?: { id: number; openclaw_job_id?: string }[];
      };
      await listRes.release();
      const existing = listBody.scheduled_tasks?.find((t) => t.openclaw_job_id === jobId);
      if (existing) {
        const body = { scheduled_task: mapCronJobToFactoryParams(job) };
        const patchRes = await fetchWithSsrFGuard({
          url: `${tasksUrl}/${existing.id}`,
          init: {
            method: "PATCH",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(FACTORY_SYNC_TIMEOUT_MS),
          },
        });
        await patchRes.response.body?.cancel();
        await patchRes.release();
        log.info({ jobId, factoryTaskId: existing.id, action }, "factory-sync: task updated");
      } else {
        // Not found — create instead (handles first-time sync)
        const body = { scheduled_task: mapCronJobToFactoryParams(job) };
        const createRes = await fetchWithSsrFGuard({
          url: tasksUrl,
          init: {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(FACTORY_SYNC_TIMEOUT_MS),
          },
        });
        await createRes.response.body?.cancel();
        await createRes.release();
        log.info({ jobId, action: "added-fallback" }, "factory-sync: task created (upsert)");
      }
    } else if (action === "removed") {
      const listRes = await fetchWithSsrFGuard({
        url: tasksUrl,
        init: { method: "GET", headers, signal: AbortSignal.timeout(FACTORY_SYNC_TIMEOUT_MS) },
      });
      const listBody = (await listRes.response.json()) as {
        scheduled_tasks?: { id: number; openclaw_job_id?: string }[];
      };
      await listRes.release();
      const existing = listBody.scheduled_tasks?.find((t) => t.openclaw_job_id === jobId);
      if (existing) {
        const delRes = await fetchWithSsrFGuard({
          url: `${tasksUrl}/${existing.id}`,
          init: {
            method: "DELETE",
            headers,
            signal: AbortSignal.timeout(FACTORY_SYNC_TIMEOUT_MS),
          },
        });
        await delRes.response.body?.cancel();
        await delRes.release();
        log.info({ jobId, factoryTaskId: existing.id, action }, "factory-sync: task deactivated");
      }
    }
  } catch (err) {
    log.warn(
      { err: formatErrorMessage(err), jobId, action },
      "factory-sync: sync failed (non-blocking)",
    );
  }
}

function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-webhook-url>";
  }
}

type CronWebhookTarget = {
  url: string;
  source: "delivery" | "legacy";
};

function resolveCronWebhookTarget(params: {
  delivery?: { mode?: string; to?: string };
  legacyNotify?: boolean;
  legacyWebhook?: string;
}): CronWebhookTarget | null {
  const mode = params.delivery?.mode?.trim().toLowerCase();
  if (mode === "webhook") {
    const url = normalizeHttpWebhookUrl(params.delivery?.to);
    return url ? { url, source: "delivery" } : null;
  }

  if (params.legacyNotify) {
    const legacyUrl = normalizeHttpWebhookUrl(params.legacyWebhook);
    if (legacyUrl) {
      return { url: legacyUrl, source: "legacy" };
    }
  }

  return null;
}

export function buildGatewayCronService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  const resolveCronSessionKey = (params: {
    runtimeConfig: ReturnType<typeof loadConfig>;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = params.requestedSessionKey?.trim();
    if (!requested) {
      return resolveAgentMainSessionKey({
        cfg: params.runtimeConfig,
        agentId: params.agentId,
      });
    }
    const candidate = toAgentStoreSessionKey({
      agentId: params.agentId,
      requestKey: requested,
      mainKey: params.runtimeConfig.session?.mainKey,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.runtimeConfig,
      agentId: params.agentId,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(params.agentId)) {
        return resolveAgentMainSessionKey({
          cfg: params.runtimeConfig,
          agentId: params.agentId,
        });
      }
    }
    return canonical;
  };

  const resolveCronWakeTarget = (opts?: { agentId?: string; sessionKey?: string | null }) => {
    const runtimeConfig = loadConfig();
    const requestedAgentId = opts?.agentId ? resolveCronAgent(opts.agentId).agentId : undefined;
    const derivedAgentId =
      requestedAgentId ??
      (opts?.sessionKey
        ? normalizeAgentId(resolveAgentIdFromSessionKey(opts.sessionKey))
        : undefined);
    const agentId = derivedAgentId || undefined;
    const sessionKey =
      opts?.sessionKey && agentId
        ? resolveCronSessionKey({
            runtimeConfig,
            agentId,
            requestedSessionKey: opts.sessionKey,
          })
        : undefined;
    return { runtimeConfig, agentId, sessionKey };
  };

  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveStorePath(params.cfg.session?.store, {
      agentId: agentId ?? defaultAgentId,
    });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);
  const warnedLegacyWebhookJobs = new Set<string>();

  const cron = new CronService({
    storePath,
    cronEnabled,
    cronConfig: params.cfg.cron,
    defaultAgentId,
    resolveSessionStorePath,
    sessionStorePath,
    enqueueSystemEvent: (text, opts) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
      const sessionKey = resolveCronSessionKey({
        runtimeConfig,
        agentId,
        requestedSessionKey: opts?.sessionKey,
      });
      enqueueSystemEvent(text, { sessionKey, contextKey: opts?.contextKey });
    },
    requestHeartbeatNow: (opts) => {
      const { agentId, sessionKey } = resolveCronWakeTarget(opts);
      requestHeartbeatNow({
        reason: opts?.reason,
        agentId,
        sessionKey,
      });
    },
    runHeartbeatOnce: async (opts) => {
      const { runtimeConfig, agentId, sessionKey } = resolveCronWakeTarget(opts);
      return await runHeartbeatOnce({
        cfg: runtimeConfig,
        reason: opts?.reason,
        agentId,
        sessionKey,
        deps: { ...params.deps, runtime: defaultRuntime },
      });
    },
    runIsolatedAgentJob: async ({ job, message }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps: params.deps,
        job,
        message,
        agentId,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
    },
    log: getChildLogger({ module: "cron", storePath }),
    onEvent: (evt) => {
      params.broadcast("cron", evt, { dropIfSlow: true });

      // --- Factory sync: mirror cron mutations to Factory API ---
      if (evt.action === "added" || evt.action === "updated" || evt.action === "removed") {
        const syncCfg = resolveFactorySyncConfig(loadConfig().cephusOps);
        if (syncCfg) {
          const job = evt.action !== "removed" ? cron.getJob(evt.jobId) : undefined;
          void syncCronEventToFactory({
            action: evt.action,
            jobId: evt.jobId,
            job: job ?? undefined,
            syncCfg,
            log: cronLogger,
          });
        }
      }

      if (evt.action === "finished") {
        const webhookToken = params.cfg.cron?.webhookToken?.trim();
        const legacyWebhook = params.cfg.cron?.webhook?.trim();
        const job = cron.getJob(evt.jobId);
        const legacyNotify = (job as { notify?: unknown } | undefined)?.notify === true;
        const webhookTarget = resolveCronWebhookTarget({
          delivery:
            job?.delivery && typeof job.delivery.mode === "string"
              ? { mode: job.delivery.mode, to: job.delivery.to }
              : undefined,
          legacyNotify,
          legacyWebhook,
        });

        if (!webhookTarget && job?.delivery?.mode === "webhook") {
          cronLogger.warn(
            {
              jobId: evt.jobId,
              deliveryTo: job.delivery.to,
            },
            "cron: skipped webhook delivery, delivery.to must be a valid http(s) URL",
          );
        }

        if (webhookTarget?.source === "legacy" && !warnedLegacyWebhookJobs.has(evt.jobId)) {
          warnedLegacyWebhookJobs.add(evt.jobId);
          cronLogger.warn(
            {
              jobId: evt.jobId,
              legacyWebhook: redactWebhookUrl(webhookTarget.url),
            },
            "cron: deprecated notify+cron.webhook fallback in use, migrate to delivery.mode=webhook with delivery.to",
          );
        }

        if (webhookTarget && evt.summary) {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (webhookToken) {
            headers.Authorization = `Bearer ${webhookToken}`;
          }
          const abortController = new AbortController();
          const timeout = setTimeout(() => {
            abortController.abort();
          }, CRON_WEBHOOK_TIMEOUT_MS);

          void (async () => {
            try {
              const result = await fetchWithSsrFGuard({
                url: webhookTarget.url,
                init: {
                  method: "POST",
                  headers,
                  body: JSON.stringify(evt),
                  signal: abortController.signal,
                },
              });
              await result.release();
            } catch (err) {
              if (err instanceof SsrFBlockedError) {
                cronLogger.warn(
                  {
                    reason: formatErrorMessage(err),
                    jobId: evt.jobId,
                    webhookUrl: redactWebhookUrl(webhookTarget.url),
                  },
                  "cron: webhook delivery blocked by SSRF guard",
                );
              } else {
                cronLogger.warn(
                  {
                    err: formatErrorMessage(err),
                    jobId: evt.jobId,
                    webhookUrl: redactWebhookUrl(webhookTarget.url),
                  },
                  "cron: webhook delivery failed",
                );
              }
            } finally {
              clearTimeout(timeout);
            }
          })();
        }
        const logPath = resolveCronRunLogPath({
          storePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(logPath, {
          ts: Date.now(),
          jobId: evt.jobId,
          action: "finished",
          status: evt.status,
          error: evt.error,
          summary: evt.summary,
          delivered: evt.delivered,
          sessionId: evt.sessionId,
          sessionKey: evt.sessionKey,
          runAtMs: evt.runAtMs,
          durationMs: evt.durationMs,
          nextRunAtMs: evt.nextRunAtMs,
          model: evt.model,
          provider: evt.provider,
          usage: evt.usage,
        }).catch((err) => {
          cronLogger.warn({ err: String(err), logPath }, "cron: run log append failed");
        });
      }
    },
  });

  return { cron, storePath, cronEnabled };
}
