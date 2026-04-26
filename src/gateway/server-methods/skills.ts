import fs from "node:fs";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { installSkill } from "../../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries, type SkillEntry } from "../../agents/skills.js";
import { bumpSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsApplyVersionParams,
  validateSkillsBinsParams,
  validateSkillsInstallParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const fsp = fs.promises;

function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const bin of anyBins) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const spec of install) {
      const specBins = spec?.bins ?? [];
      for (const bin of specBins) {
        const trimmed = String(bin).trim();
        if (trimmed) {
          bins.add(trimmed);
        }
      }
    }
  }
  return [...bins].toSorted();
}

function sanitizeSegment(raw: string): string {
  const normalized = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "skill";
}

function normalizeRelativeSkillPath(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\+/g, "/").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("/") || normalized.includes("..")) {
    return null;
  }
  return normalized;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readOperationMarker(markerPath: string): Promise<{ operationId?: string }> {
  try {
    const raw = await fsp.readFile(markerPath, "utf8");
    const parsed = JSON.parse(raw) as { operationId?: string };
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export const skillsHandlers: GatewayRequestHandlers = {
  "skills.status": ({ params, respond }) => {
    if (!validateSkillsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentIdRaw = typeof params?.agentId === "string" ? params.agentId.trim() : "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
    if (agentIdRaw) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
        );
        return;
      }
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: cfg,
      eligibility: { remote: getRemoteSkillEligibility() },
    });
    respond(true, report, undefined);
  },
  "skills.bins": ({ params, respond }) => {
    if (!validateSkillsBinsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDirs = listAgentWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.install": async ({ params, respond }) => {
    if (!validateSkillsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      timeoutMs?: number;
    };
    const cfg = loadConfig();
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      skillName: p.name,
      installId: p.installId,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.update": async ({ params, respond }) => {
    if (!validateSkillsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
    };
    const cfg = loadConfig();
    const skills = cfg.skills ? { ...cfg.skills } : {};
    const entries = skills.entries ? { ...skills.entries } : {};
    const current = entries[p.skillKey] ? { ...entries[p.skillKey] } : {};
    if (typeof p.enabled === "boolean") {
      current.enabled = p.enabled;
    }
    if (typeof p.apiKey === "string") {
      const trimmed = normalizeSecretInput(p.apiKey);
      if (trimmed) {
        current.apiKey = trimmed;
      } else {
        delete current.apiKey;
      }
    }
    if (p.env && typeof p.env === "object") {
      const nextEnv = current.env ? { ...current.env } : {};
      for (const [key, value] of Object.entries(p.env)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) {
          continue;
        }
        const trimmedVal = value.trim();
        if (!trimmedVal) {
          delete nextEnv[trimmedKey];
        } else {
          nextEnv[trimmedKey] = trimmedVal;
        }
      }
      current.env = nextEnv;
    }
    entries[p.skillKey] = current;
    skills.entries = entries;
    const nextConfig: OpenClawConfig = {
      ...cfg,
      skills,
    };
    await writeConfigFile(nextConfig);
    respond(true, { ok: true, skillKey: p.skillKey, config: current }, undefined);
  },
  "skills.applyVersion": async ({ params, respond }) => {
    if (!validateSkillsApplyVersionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.applyVersion params: ${formatValidationErrors(validateSkillsApplyVersionParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as {
      operationId: string;
      action: "assign" | "unassign" | "reconcile";
      agentId?: string;
      skill: {
        slug: string;
        files?: Array<{ path: string; contentText?: string }>;
      };
      assignment?: {
        enabled?: boolean;
      };
    };

    const cfg = loadConfig();
    const requestedAgentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
    const normalizedAgentId = requestedAgentId
      ? normalizeAgentId(requestedAgentId)
      : resolveDefaultAgentId(cfg);

    if (requestedAgentId) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(normalizedAgentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
        );
        return;
      }
    }

    const workspaceDir = resolveAgentWorkspaceDir(cfg, normalizedAgentId);
    const skillDirName = `cephus-${sanitizeSegment(p.skill.slug)}`;
    const skillDir = path.join(workspaceDir, "skills", skillDirName);
    const markerPath = path.join(skillDir, ".cephus-sync.json");
    const existingMarker = await readOperationMarker(markerPath);

    if (existingMarker.operationId === p.operationId) {
      respond(
        true,
        {
          ok: true,
          operationId: p.operationId,
          action: p.action,
          applied: true,
          idempotent: true,
          workspaceDir,
          skillDir,
        },
        undefined,
      );
      return;
    }

    const shouldUnassign = p.action === "unassign" || p.assignment?.enabled === false;
    if (shouldUnassign) {
      const existed = await pathExists(skillDir);
      if (existed) {
        await fsp.rm(skillDir, { recursive: true, force: true });
      }
      bumpSkillsSnapshotVersion({ workspaceDir, reason: "manual" });
      respond(
        true,
        {
          ok: true,
          operationId: p.operationId,
          action: p.action,
          applied: true,
          idempotent: false,
          removed: true,
          workspaceDir,
          skillDir,
        },
        undefined,
      );
      return;
    }

    const files = Array.isArray(p.skill.files) ? p.skill.files : [];
    const skillMd = files.find(
      (file) => file.path === "SKILL.md" && typeof file.contentText === "string",
    );
    if (!skillMd) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "skills.applyVersion requires SKILL.md with inline contentText",
        ),
      );
      return;
    }

    await fsp.mkdir(skillDir, { recursive: true });
    let filesWritten = 0;

    for (const file of files) {
      if (typeof file.contentText !== "string") {
        continue;
      }
      const relativePath = normalizeRelativeSkillPath(file.path);
      if (!relativePath) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `invalid skill file path: ${String(file.path)}`),
        );
        return;
      }

      const destination = path.join(skillDir, relativePath);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, file.contentText, "utf8");
      filesWritten += 1;
    }

    await fsp.writeFile(
      markerPath,
      JSON.stringify(
        {
          operationId: p.operationId,
          appliedAt: new Date().toISOString(),
          action: p.action,
          slug: p.skill.slug,
        },
        null,
        2,
      ),
      "utf8",
    );

    bumpSkillsSnapshotVersion({ workspaceDir, reason: "manual" });
    respond(
      true,
      {
        ok: true,
        operationId: p.operationId,
        action: p.action,
        applied: true,
        idempotent: false,
        workspaceDir,
        skillDir,
        filesWritten,
      },
      undefined,
    );
  },
};
