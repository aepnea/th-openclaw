import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRegistry } from "../registry.js";
import type {
  PluginLogger,
  PluginHookAfterToolCallEvent,
  PluginHookBeforeToolCallEvent,
} from "../types.js";

export type PolicyContext = {
  source?: string;
  memory_scope?: "global" | "agent";
  owner_user_id?: string;
  agent_id?: string;
  memory_snapshot?: {
    counts: {
      agent: number;
      global: number;
      resolved: number;
    };
    resolved: Array<{
      id?: string;
      memory_scope?: "global" | "agent";
      owner_user_id?: string;
      memory_type?: string;
      confidence?: number;
      content?: string;
      scope_type?: string;
      scope_key?: string;
    }>;
  };
};

type CephusPolicyDecision = {
  decision?: "allow" | "warn" | "block" | "degrade";
  reason?: string;
  trace_id?: string;
  degrade_actions?: Array<Record<string, unknown>>;
};

type DegradeAction = {
  action?: string;
  max_results?: number;
  max_items?: number;
  profile?: string;
  [key: string]: unknown;
};

type CephusPolicyResponse = {
  data?: CephusPolicyDecision;
};

type SnapshotRecord = {
  id?: unknown;
  memory_scope?: unknown;
  owner_user_id?: unknown;
  memory_type?: unknown;
  confidence?: unknown;
  content?: unknown;
  scope_type?: unknown;
  scope_key?: unknown;
};

type OperationalMemorySnapshot = {
  agent: SnapshotRecord[];
  global: SnapshotRecord[];
  resolved: SnapshotRecord[];
};

type SnapshotResponse = {
  data?: {
    agent?: unknown;
    global?: unknown;
    resolved?: unknown;
  };
};

type CephusBudgetConfig = NonNullable<OpenClawConfig["cephusOps"]>;
type ResolvedCephusBudgetConfig = CephusBudgetConfig & {
  baseUrl: string;
  agentId: string;
};

const CORE_PLUGIN_ID = "openclaw-core-cephus-budget";
const CORE_PLUGIN_SOURCE = "core://cephus-budget-threshold";
const MAX_SESSION_DEDUPED_EXTERNAL_REFS = 256;
const MAX_TRACKED_SESSIONS = 256;
const SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_MAX_RESOLVED_ITEMS = 25;
const SNAPSHOT_MAX_CONTENT_LENGTH = 300;
const seenExternalRefsBySession = new Map<string, Set<string>>();
const snapshotBySession = new Map<
  string,
  {
    expiresAtMs: number;
    snapshot: OperationalMemorySnapshot | null;
  }
>();

function normalizePolicyContext(raw: unknown): PolicyContext {
  if (!raw || typeof raw !== "object") {
    return { source: "th-openclaw" };
  }

  const candidate = raw as Record<string, unknown>;
  const memoryScope = normalizeMemoryScope(candidate.memory_scope);

  const ownerUserId =
    typeof candidate.owner_user_id === "string" && candidate.owner_user_id.trim()
      ? candidate.owner_user_id
      : undefined;

  const agentId =
    typeof candidate.agent_id === "string" && candidate.agent_id.trim()
      ? candidate.agent_id
      : undefined;

  const memorySnapshot = normalizeSnapshotForPolicyContext(candidate.memory_snapshot);

  return {
    source: "th-openclaw",
    memory_scope: memoryScope,
    owner_user_id: ownerUserId,
    agent_id: agentId,
    memory_snapshot: memorySnapshot,
  };
}

function normalizeMemoryScope(value: unknown): "global" | "agent" | undefined {
  return value === "global" || value === "agent" ? value : undefined;
}

function normalizeSnapshotRecords(input: unknown): SnapshotRecord[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((entry): entry is SnapshotRecord => !!entry && typeof entry === "object");
}

function normalizeSnapshotResponse(input: unknown): OperationalMemorySnapshot | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const payload = input as SnapshotResponse;
  const data = payload.data;
  if (!data || typeof data !== "object") {
    return null;
  }

  return {
    agent: normalizeSnapshotRecords(data.agent),
    global: normalizeSnapshotRecords(data.global),
    resolved: normalizeSnapshotRecords(data.resolved),
  };
}

function takeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function takeFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function normalizeSnapshotForPolicyContext(raw: unknown): PolicyContext["memory_snapshot"] {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  const counts = candidate.counts;
  const resolved = normalizeSnapshotRecords(candidate.resolved);

  const countCandidate =
    counts && typeof counts === "object" ? (counts as Record<string, unknown>) : {};
  return {
    counts: {
      agent: toPositiveInteger(countCandidate.agent) ?? 0,
      global: toPositiveInteger(countCandidate.global) ?? 0,
      resolved: toPositiveInteger(countCandidate.resolved) ?? resolved.length,
    },
    resolved: resolved.slice(0, SNAPSHOT_MAX_RESOLVED_ITEMS).map((entry) => ({
      id: takeNonEmptyString(entry.id),
      memory_scope: normalizeMemoryScope(entry.memory_scope),
      owner_user_id: takeNonEmptyString(entry.owner_user_id),
      memory_type: takeNonEmptyString(entry.memory_type),
      confidence: takeFiniteNumber(entry.confidence),
      content: takeNonEmptyString(entry.content)?.slice(0, SNAPSHOT_MAX_CONTENT_LENGTH),
      scope_type: takeNonEmptyString(entry.scope_type),
      scope_key: takeNonEmptyString(entry.scope_key),
    })),
  };
}

function buildSnapshotContext(
  snapshot: OperationalMemorySnapshot,
): PolicyContext["memory_snapshot"] {
  const resolved = snapshot.resolved.slice(0, SNAPSHOT_MAX_RESOLVED_ITEMS).map((entry) => ({
    id: takeNonEmptyString(entry.id),
    memory_scope: normalizeMemoryScope(entry.memory_scope),
    owner_user_id: takeNonEmptyString(entry.owner_user_id),
    memory_type: takeNonEmptyString(entry.memory_type),
    confidence: takeFiniteNumber(entry.confidence),
    content: takeNonEmptyString(entry.content)?.slice(0, SNAPSHOT_MAX_CONTENT_LENGTH),
    scope_type: takeNonEmptyString(entry.scope_type),
    scope_key: takeNonEmptyString(entry.scope_key),
  }));

  return {
    counts: {
      agent: snapshot.agent.length,
      global: snapshot.global.length,
      resolved: snapshot.resolved.length,
    },
    resolved,
  };
}

function resolveSnapshotOwnerUserId(snapshot: OperationalMemorySnapshot): string | undefined {
  for (const row of [...snapshot.resolved, ...snapshot.global, ...snapshot.agent]) {
    const owner = takeNonEmptyString(row.owner_user_id);
    if (owner) {
      return owner;
    }
  }
  return undefined;
}

function resolveSnapshotScope(snapshot: OperationalMemorySnapshot): "global" | "agent" | undefined {
  const hasAgent = snapshot.resolved.some((row) => row.memory_scope === "agent");
  if (hasAgent) {
    return "agent";
  }
  const hasGlobal =
    snapshot.resolved.some((row) => row.memory_scope === "global") || snapshot.global.length > 0;
  return hasGlobal ? "global" : undefined;
}

function mergeSnapshotIntoPolicyContext(params: {
  base: PolicyContext;
  snapshot: OperationalMemorySnapshot | null;
  agentId: string;
}): PolicyContext {
  const { base, snapshot, agentId } = params;
  if (!snapshot) {
    return {
      ...base,
      agent_id: base.agent_id ?? agentId,
    };
  }

  return {
    ...base,
    agent_id: base.agent_id ?? agentId,
    owner_user_id: base.owner_user_id ?? resolveSnapshotOwnerUserId(snapshot),
    memory_scope: base.memory_scope ?? resolveSnapshotScope(snapshot),
    memory_snapshot: buildSnapshotContext(snapshot),
  };
}

async function fetchOperationalMemorySnapshot(
  config: ResolvedCephusBudgetConfig,
  agentId: string,
): Promise<OperationalMemorySnapshot | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 2500);

  try {
    const baseUrl = config.baseUrl.replace(/\/$/, "");
    const url = `${baseUrl}/api/operational_memories/snapshot?agent_id=${encodeURIComponent(agentId)}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (config.apiToken?.trim()) {
      headers.authorization = `Bearer ${config.apiToken.trim()}`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as SnapshotResponse;
    return normalizeSnapshotResponse(payload);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getSessionSnapshot(
  config: ResolvedCephusBudgetConfig,
  sessionKey: string | undefined,
  agentId: string,
): Promise<OperationalMemorySnapshot | null> {
  const key = sessionKey?.trim() || "session:unknown";
  const now = Date.now();
  const cached = snapshotBySession.get(key);
  if (cached && cached.expiresAtMs > now) {
    return cached.snapshot;
  }

  const snapshot = await fetchOperationalMemorySnapshot(config, agentId);
  snapshotBySession.set(key, {
    snapshot,
    expiresAtMs: now + SNAPSHOT_CACHE_TTL_MS,
  });

  if (snapshotBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = snapshotBySession.keys().next().value;
    if (oldest) {
      snapshotBySession.delete(oldest);
    }
  }

  return snapshot;
}

function attachPolicyContextToParams(
  params: Record<string, unknown>,
  context: PolicyContext,
): Record<string, unknown> {
  return {
    ...params,
    _policy_context: {
      ...context,
    },
  };
}

function hasHook(
  registry: PluginRegistry,
  hookName: "before_tool_call" | "after_tool_call",
): boolean {
  return registry.typedHooks.some(
    (entry) => entry.pluginId === CORE_PLUGIN_ID && entry.hookName === hookName,
  );
}

function resolveConfig(config: OpenClawConfig): ResolvedCephusBudgetConfig | null {
  const raw = config.cephusOps;
  if (!raw?.enabled || !raw.baseUrl || !raw.agentId) {
    return null;
  }
  return {
    ...raw,
    baseUrl: raw.baseUrl,
    agentId: raw.agentId,
    timeoutMs: raw.timeoutMs ?? 2500,
    failMode: raw.failMode ?? "open",
    defaultEstimatedCostUsd: raw.defaultEstimatedCostUsd ?? 0.01,
    estimatedCostByToolUsd: raw.estimatedCostByToolUsd ?? {},
  };
}

function resolveEstimatedCostUsd(config: CephusBudgetConfig, toolName: string): number {
  const fromMap = config.estimatedCostByToolUsd?.[toolName];
  if (typeof fromMap === "number" && Number.isFinite(fromMap) && fromMap >= 0) {
    return fromMap;
  }
  return config.defaultEstimatedCostUsd ?? 0.01;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function applyMinInteger(base: unknown, candidate: number): number {
  const current = toPositiveInteger(base);
  if (!current) {
    return candidate;
  }
  return Math.min(current, candidate);
}

function normalizeDegradeActions(input: unknown): DegradeAction[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((entry): entry is DegradeAction => !!entry && typeof entry === "object");
}

function applyDegradeActionsToParams(
  params: Record<string, unknown>,
  actions: unknown,
): Record<string, unknown> {
  const degradeActions = normalizeDegradeActions(actions);
  if (degradeActions.length === 0) {
    return params;
  }

  const nextParams: Record<string, unknown> = { ...params };
  const applied: Array<Record<string, unknown>> = [];

  for (const actionEntry of degradeActions) {
    const actionName = typeof actionEntry.action === "string" ? actionEntry.action : "";

    if (actionName === "model_downgrade" || actionName === "downgrade_model") {
      nextParams.modelProfile = "cost_saver";
      nextParams._degrade_model = true;
      applied.push({ action: "model_downgrade", profile: actionEntry.profile ?? "cost_saver" });
      continue;
    }

    if (actionName === "retrieval_cap" || actionName === "cap_retrieval") {
      const maxResults = toPositiveInteger(actionEntry.max_results);
      if (maxResults) {
        nextParams.maxResults = applyMinInteger(nextParams.maxResults, maxResults);
        applied.push({ action: "retrieval_cap", max_results: maxResults });
      }
      continue;
    }

    if (actionName === "memory_clamp" || actionName === "clamp_memory") {
      const maxItems = toPositiveInteger(actionEntry.max_items);
      if (maxItems) {
        nextParams.maxItems = applyMinInteger(nextParams.maxItems, maxItems);
        applied.push({ action: "memory_clamp", max_items: maxItems });
      }
      continue;
    }
  }

  if (applied.length > 0) {
    nextParams._degrade_applied = applied;
  }

  return nextParams;
}

function resolveRoundIndex(params: Record<string, unknown>): number {
  const raw = params.roundIndex ?? params.round_index ?? params._round_index ?? 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.floor(raw));
}

function buildDeterministicExternalRef(input: {
  agentId: string;
  sessionKey?: string;
  toolName: string;
  params: Record<string, unknown>;
}): string {
  const roundIndex = resolveRoundIndex(input.params);
  const stableRaw = `${input.agentId}|${input.sessionKey ?? "session:unknown"}|${input.toolName}|${roundIndex}`;
  const digest = stableHexHash(stableRaw);
  return `cephus:${digest}`;
}

function stableHexHash(input: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35];
  const state = seeds.slice();

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    for (let i = 0; i < state.length; i += 1) {
      state[i] ^= code + i;
      state[i] = Math.imul(state[i], 16777619) >>> 0;
      state[i] ^= state[i] >>> 13;
      state[i] = Math.imul(state[i], 2246822519) >>> 0;
    }
  }

  return state
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("")
    .repeat(2);
}

function isExternalRefAlreadySeen(sessionKey: string | undefined, externalRef: string): boolean {
  const key = sessionKey?.trim() || "session:unknown";
  let refs = seenExternalRefsBySession.get(key);
  if (!refs) {
    refs = new Set<string>();
    seenExternalRefsBySession.set(key, refs);
    if (seenExternalRefsBySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = seenExternalRefsBySession.keys().next().value;
      if (oldest) {
        seenExternalRefsBySession.delete(oldest);
      }
    }
  }

  if (refs.has(externalRef)) {
    return true;
  }

  refs.add(externalRef);
  if (refs.size > MAX_SESSION_DEDUPED_EXTERNAL_REFS) {
    const oldestRef = refs.values().next().value;
    if (oldestRef) {
      refs.delete(oldestRef);
    }
  }

  return false;
}

async function postCephusPolicy(
  config: CephusBudgetConfig,
  path: string,
  payload: Record<string, unknown>,
): Promise<CephusPolicyDecision | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 2500);

  try {
    const url = `${config.baseUrl!.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (config.apiToken?.trim()) {
      headers.authorization = `Bearer ${config.apiToken.trim()}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const parsed = (await response.json()) as CephusPolicyResponse;
    return parsed.data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function registerCephusBudgetThresholdHooks(
  registry: PluginRegistry,
  config: OpenClawConfig,
  logger: PluginLogger,
): void {
  const cephus = resolveConfig(config);
  if (!cephus) {
    return;
  }

  const beforeToolCall = async (
    event: PluginHookBeforeToolCallEvent,
    ctx: { sessionKey?: string; agentId?: string },
  ) => {
    const estimatedCost = resolveEstimatedCostUsd(cephus, event.toolName);
    const baseContext = normalizePolicyContext(event.params?.["_policy_context"]);
    const snapshot = await getSessionSnapshot(cephus, ctx.sessionKey, cephus.agentId);
    const policyContext = mergeSnapshotIntoPolicyContext({
      base: baseContext,
      snapshot,
      agentId: cephus.agentId,
    });
    const paramsWithContext = attachPolicyContextToParams(event.params, policyContext);
    const decision = await postCephusPolicy(
      cephus,
      `/api/agents/${cephus.agentId}/policy/pre_action`,
      {
        action_type: event.toolName,
        estimated_cost: estimatedCost,
        context: policyContext,
      },
    );

    if (!decision) {
      if (cephus.failMode === "closed") {
        return {
          block: true,
          blockReason: "Policy service unavailable (fail-closed)",
        };
      }
      return {
        params: paramsWithContext,
      };
    }

    if (decision.decision === "block") {
      return {
        block: true,
        blockReason: decision.reason || "Blocked by budget policy",
      };
    }

    if (decision.decision === "degrade") {
      const adjustedParams = applyDegradeActionsToParams(
        paramsWithContext,
        decision.degrade_actions ?? [],
      );
      return {
        params: {
          ...adjustedParams,
          _budget_policy: {
            trace_id: decision.trace_id,
            degrade_actions: decision.degrade_actions ?? [],
          },
        },
      };
    }

    return {
      params: paramsWithContext,
    };
  };

  const afterToolCall = async (
    event: PluginHookAfterToolCallEvent,
    ctx: { sessionKey?: string; agentId?: string },
  ) => {
    const estimatedCost = resolveEstimatedCostUsd(cephus, event.toolName);
    const baseContext = normalizePolicyContext(event.params?.["_policy_context"]);
    const snapshot =
      baseContext.memory_snapshot || baseContext.owner_user_id || baseContext.memory_scope
        ? null
        : await getSessionSnapshot(cephus, ctx.sessionKey, cephus.agentId);
    const policyContext = mergeSnapshotIntoPolicyContext({
      base: baseContext,
      snapshot,
      agentId: cephus.agentId,
    });
    const externalRef = buildDeterministicExternalRef({
      agentId: cephus.agentId,
      sessionKey: ctx.sessionKey,
      toolName: event.toolName,
      params: event.params,
    });

    if (isExternalRefAlreadySeen(ctx.sessionKey, externalRef)) {
      return;
    }

    await postCephusPolicy(cephus, `/api/agents/${cephus.agentId}/policy/post_action`, {
      action_type: event.toolName,
      amount: estimatedCost,
      success: !event.error,
      external_ref: externalRef,
      metadata: {
        source: "th-openclaw",
        duration_ms: event.durationMs,
      },
      context: policyContext,
    });
  };

  if (!hasHook(registry, "before_tool_call")) {
    registry.typedHooks.push({
      pluginId: CORE_PLUGIN_ID,
      hookName: "before_tool_call",
      handler: beforeToolCall,
      priority: 100,
      source: CORE_PLUGIN_SOURCE,
    });
  }

  if (!hasHook(registry, "after_tool_call")) {
    registry.typedHooks.push({
      pluginId: CORE_PLUGIN_ID,
      hookName: "after_tool_call",
      handler: afterToolCall,
      priority: 10,
      source: CORE_PLUGIN_SOURCE,
    });
  }

  logger.info("[plugins] registered core cephus budget threshold hooks");
}
