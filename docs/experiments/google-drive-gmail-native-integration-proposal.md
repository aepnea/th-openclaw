---
title: Google Drive + Gmail Native Integration Proposal
summary: Alternatives analysis and phased plan for OpenClaw-native Google Workspace integrations
status: phase-1-backend-complete
owner: proposal
selected-alternative: B
phase1-plugin-completion-date: 2026-03-19
phase1-backend-completion-date: 2026-03-20
---

# Google Drive + Gmail Native Integration Proposal

## Objective
Add OpenClaw-native integrations for:
- Gmail (read/search/send/manage)
- Google Drive (search/read/download/export/upload)

"Native" in this proposal means first-class OpenClaw tooling and auth flows that follow OpenClaw plugin/config patterns AND are surfaced in the Cephus Agent Factory so users can configure and assign them to agents.

## Architecture Constraints (non-negotiable)

1. **All plugin code lives in `th-openclaw` repo** — under `th-openclaw/extensions/google-workspace/`. This keeps the plugin aligned with the OpenClaw release cycle, testable in its own extension harness, and independently versioned.
2. **All agent-facing integration management goes through Cephus** — the Agent Factory (`openclaw-agent-factory`) is the control plane. Adding the integration to Cephus means:
   - A new `google_workspace` channel type entry in `ChannelIntegrationService::CHANNEL_CONFIGS`
   - OAuth credential storage via the `ChannelCredential` model
   - Webhook registration record in `WebhookRegistration` (for Gmail Pub/Sub event path)
   - UI surface in the Cephus frontend so users can connect their Google account and enable tools per agent

These two layers are independent but must ship together for a complete integration.

## Current State (from OpenClaw docs)
- Gmail exists today via webhook automation path (`gog gmail watch serve` -> `/hooks/gmail`) and preset mappings.
- There is no first-class Google Drive integration in core channels/tools docs.
- OpenClaw supports first-class extension patterns for tools/providers via plugin manifests and typed tool registration.
- Cephus currently exposes channels: `whatsapp`, `slack`, `discord`, `telegram`, `cephus` — Google Workspace is absent.

Relevant docs reviewed:
- `docs/automation/gmail-pubsub.md`
- `docs/automation/webhook.md`
- `docs/tools/plugin.md`
- `docs/plugins/manifest.md`
- `docs/plugins/agent-tools.md`
- `docs/concepts/model-providers.md`
- `app/services/channel_integration_service.rb` (Cephus)

## Alternatives Analyzed

### Alternative A: Keep webhook-only approach (extend current Gmail flow + external scripts)
Description:
- Continue using `/hooks/gmail` mappings and external daemons/scripts for Gmail/Drive operations.

Pros:
- Fastest to patch
- Reuses current Gmail webhook docs and infra

Cons:
- Not truly native in OpenClaw tool surface
- Hard to compose in agent plans (`message` + external shell glue)
- Inconsistent auth/session UX
- No unified capability model for Drive/Gmail actions

Verdict:
- Good stopgap, poor long-term platform fit.

### Alternative B: OpenClaw plugin-native integration (recommended)
Description:
- Build an official plugin (suggested id: `google-workspace`) that registers typed agent tools and optional OAuth helper commands.
- Keep Gmail Pub/Sub webhook as optional event trigger path, but not the only integration path.

Pros:
- Aligns with OpenClaw extension architecture (manifest, schema validation, typed tools)
- Incremental delivery possible without risky core refactor
- Consistent with tool allow/deny profiles and per-agent tool policy
- Easier security hardening via explicit scopes + optional tools

Cons:
- Slightly more setup than webhook-only
- Requires plugin release/versioning and maintenance

Verdict:
- Best balance of native UX, safety, and delivery speed.

### Alternative C: Core-only integration (hardcode into OpenClaw core tools)
Description:
- Add Drive/Gmail directly into core tool registry and config schemas.

Pros:
- Max discoverability in core

Cons:
- Larger blast radius and slower merge path
- Harder to iterate scope/scopes safely
- Less modular than plugin model already encouraged by OpenClaw docs

Verdict:
- Consider only after plugin maturity proves stable demand.

## Recommendation
Proceed with **Alternative B (plugin-native)** — confirmed selected.

## Implementation Layers

### Layer 1 — OpenClaw Plugin (`th-openclaw` repo)
Location: `th-openclaw/extensions/google-workspace/`

Responsible for:
- Plugin manifest (`openclaw.plugin.json`)
- JSON config schema (auth profile, scope profiles, limits)
- TypeScript tool registration (`api.registerTool(...)`)
- OAuth token lifecycle helpers (exchange, refresh, revoke)
- All Gmail + Drive API call logic
- Unit and integration tests
- Plugin docs at `docs/extensions/google-workspace.md`

This layer is self-contained, versioned, and tested independently before being wired into Cephus.

### Layer 2 — Cephus Agent Factory (`openclaw-agent-factory` repo)
Responsible for:
- New `google_workspace` entry in `ChannelIntegrationService::CHANNEL_CONFIGS`
- `ChannelCredential` support for `channel_type: :google_workspace`
- `validate_google_workspace_credential!` method (verifies OAuth token validity)
- `register_google_workspace_webhook!` method (registers Gmail Pub/Sub endpoint for push notifications)
- Frontend: credential setup flow and per-agent tool toggle in agent settings UI
- Rails routes for OAuth callback (`/auth/google_workspace/callback`)

The Cephus layer delegates actual API calls to the OpenClaw gateway (which runs the plugin). Cephus manages credentials, user consent, and which agents have the integration enabled.

## Proposed Integration Design

### 1) Package + registration
- Official plugin package: `@openclaw/google-workspace` (located at `th-openclaw/extensions/google-workspace/`)
- Manifest declares:
  - `id: "google-workspace"`
  - `configSchema` for auth/scopes/defaults
  - optional `providers` entry only if we also expose provider auth helpers
- Register agent tools with strict JSON schemas
- Mark high-risk side-effect tools as `optional: true`

### 2) Auth model
Primary path (v1):
- OAuth 2.0 for Google Workspace APIs
- Cephus initiates and stores the OAuth grant (user-facing consent via `/auth/google_workspace`)
- Token forwarded to OpenClaw auth profile on the gateway at agent activation time
- Token storage in OpenClaw auth profile pattern (same operational style as other auth plugins)

Fallback path (optional):
- Service account JSON key mode for org-controlled internal deployments (upload via Cephus credential form)

### 3) Tool surface (initial)

#### Gmail tools (v1)
- `gmail_search_messages`
- `gmail_get_message`
- `gmail_list_threads`
- `gmail_send_message` (optional)
- `gmail_modify_labels` (optional)
- `gmail_get_attachment`

#### Drive tools (v1)
- `drive_search_files`
- `drive_get_file`
- `drive_download_file`
- `drive_export_google_doc`
- `drive_upload_file` (optional)
- `drive_create_folder` (optional)
- `drive_share_file` (optional)

### 4) Scopes strategy (least privilege)
Default read profile:
- Gmail read scopes
- Drive read scopes

Elevated write profile (explicit opt-in):
- Gmail send/modify
- Drive file write/share

Policy:
- Tool availability gates on granted scopes.
- Write/share tools hidden/denied when elevated scopes are absent.

### 5) Safety + governance
- Tool deny/allow compatible with existing `tools.profile`, `tools.allow`, `tools.deny`, and per-agent overrides
- Redact sensitive payload fields from logs
- Max attachment/file size limits + MIME allowlist
- Domain allowlist option for outbound email and share links
- Confirmation pattern for destructive/externally-visible actions

### 6) Relationship with existing Gmail Pub/Sub flow
Keep existing webhook path and position it as:
- event trigger ingress for "new email arrived"
- optional supplement to native Gmail tools

Native tools become the primary API for:
- deterministic retrieval
- search
- controlled send/label operations

## Phased Rollout

### Phase 1: Read-only foundation (low risk)
**th-openclaw:**
- Plugin scaffold: `extensions/google-workspace/` with manifest and config schema
- OAuth + token lifecycle helpers
- Gmail tools: `gmail_search_messages`, `gmail_get_message`, `gmail_list_threads`, `gmail_get_attachment`
- Drive tools: `drive_search_files`, `drive_get_file`, `drive_download_file`, `drive_export_google_doc`
- Strict read-only scopes
- Unit tests + docs

**Cephus:**
- `google_workspace` channel type in `CHANNEL_CONFIGS`
- OAuth credential form (client_id, client_secret, redirect URI)
- `validate_google_workspace_credential!` method
- Per-agent toggle to enable/disable google-workspace tools

Exit criteria:
- Stable auth, retries, pagination, and error semantics
- Agent can search Gmail and Drive via Playground
- No write actions possible

### Phase 2: Write operations (guarded)
**th-openclaw:**
- Gmail write tools: `gmail_send_message` (optional), `gmail_modify_labels` (optional)
- Drive write tools: `drive_upload_file` (optional), `drive_create_folder` (optional), `drive_share_file` (optional)
- Elevated write scope profile
- Confirmation and policy checks in tool definitions

**Cephus:**
- Write scope opt-in toggle in agent settings (separate from read toggle)
- Elevated scope grant request flow in OAuth UI
- Auditable event log surface (read from deployment events)

Exit criteria:
- Write operations gated by explicit config and scopes
- Auditable event logs with redaction

### Phase 3: Eventing and automation convergence
**th-openclaw:**
- Optional bridge between Gmail Pub/Sub events and native tool workflows
- Task templates for inbox triage and Drive workflows

**Cephus:**
- Gmail Pub/Sub webhook registration (`register_google_workspace_webhook!`) in `ChannelIntegrationService`
- `/hooks/google_workspace/gmail` webhook endpoint in Rails router
- Webhook-to-agent routing (same pattern as Slack/WhatsApp channels today)

Exit criteria:
- "Receive new email → trigger agent" automation works end-to-end
- Pattern documented and testable from Cephus UI

## Minimal Config Sketch (proposal)
```json5
{
  plugins: {
    entries: {
      "google-workspace": {
        enabled: true,
        config: {
          authProfile: "google-workspace-default",
          scopeProfile: "read", // read | write
          drive: {
            maxDownloadMb: 20,
            allowedMimePrefixes: ["text/", "application/pdf"],
          },
          gmail: {
            maxAttachmentMb: 20,
            allowedRecipientDomains: ["company.com"],
          },
        },
      },
    },
  },
}
```

## Risks and Mitigations
- OAuth complexity and token expiry:
  - Mitigation: centralized auth helpers + refresh token health checks.
- Over-scoped permissions:
  - Mitigation: read-default profile + explicit write profile.
- Data exfiltration via tool misuse:
  - Mitigation: allow/deny policies, domain restrictions, redaction, optional confirmations.
- API quota/rate limits:
  - Mitigation: backoff, paging constraints, bounded retries.

## Success Metrics
- Time-to-first-use for read-only flows under 10 minutes
- >95% successful read operations in integration test harness
- Zero plaintext token leaks in logs
- No write actions possible without explicit elevated scope profile

## Approval Request
If approved, implementation starts with **Phase 1 only (read-only)**:

### th-openclaw deliverables (Phase 1)
1. Plugin scaffold: `th-openclaw/extensions/google-workspace/` with `openclaw.plugin.json` manifest + JSON schema
2. Typed tool contracts: Gmail read tools + Drive read tools
3. OAuth auth profile helper
4. Tests + docs for setup and security defaults

### Cephus deliverables (Phase 1)
1. `google_workspace` added to `ChannelIntegrationService::CHANNEL_CONFIGS`
2. `validate_google_workspace_credential!` service method
3. `ChannelCredential` accepts `channel_type :google_workspace`
4. Basic credential setup UI in agent settings (OAuth initiation)
5. Per-agent enable/disable toggle for Google Workspace tools

No code changes are proposed in this document beyond planning. Awaiting approval to begin Phase 1.

---

## Phase 1 Implementation Status: ✅ COMPLETE

**Completion Date:** March 19, 2026

### Deliverables Completed

**th-openclaw/extensions/google-workspace/** — All files created and tested:

✅ **EPIC 1: Plugin Scaffold** (1.25 h)
- `openclaw.plugin.json` — plugin metadata
- `package.json` — dependencies (googleapis, google-auth-library, typebox, zod)
- `index.ts` — plugin entry point with config parsing & tool registration
- Directory structure: `src/`, `docs/`

✅ **EPIC 2: OAuth & Auth Layer** (2.5 h)
- `src/config-schema.ts` — Zod schema for plugin config (OAuth2 + service account modes)
- `src/auth.ts` — Token lifecycle (exchange, refresh, revoke, expiry handling)
- `src/auth.test.ts` — Unit tests with mocked google-auth-library (OAuth2 + SA modes)

✅ **EPIC 3: Gmail Read Tools** (2.5 h)
- `src/gmail-schemas.ts` — TypeBox Union schema (4 actions: search_messages, get_message, list_threads, get_attachment)
- `src/gmail.ts` — Gmail API integration with `api.registerTool()` call
- `src/gmail.test.ts` — Tool tests

✅ **EPIC 4: Drive Read Tools** (2.5 h)
- `src/drive-schemas.ts` — TypeBox Union schema (4 actions: search_files, get_file, download_file, export_google_doc)
- `src/drive.ts` — Drive API integration with MIME type & size enforcement
- `src/drive.test.ts` — Tool tests

✅ **EPIC 5: Tests, Docs & Safety** (2 h)
- `index.test.ts` — Integration tests (config validation, log redaction, security tests)
- `docs/setup.md` — OAuth2/service account setup guide, tool reference, troubleshooting
- `docs/security.md` — Threat model, mitigations, incident response playbook

**Total Phase 1 Effort:** ~15.25 hours ✅

### Code Quality
- ✅ Full test coverage (unit + integration)
- ✅ Log redaction (no tokens leak)
- ✅ TypeBox/Zod schemas for type safety
- ✅ Error handling with user-friendly messages
- ✅ Follows th-openclaw extension best practices
- ✅ Production-ready code

### Next Steps
**Phase 2 Ready:** Implement in `openclaw-agent-factory` repo for Cephus integration

---

## Epics, Tasks & AI Agent Time Estimates

> Estimates assume a single AI coding agent working autonomously with full access to both repos, running tests in a feedback loop, and producing production-ready code. Times are wall-clock estimates (agent execution time, not calendar time).

---

### EPIC 1 — Plugin Scaffold (th-openclaw) ✅ COMPLETE
**Scope:** Create the extension skeleton in `th-openclaw/extensions/google-workspace/`
**Repo:** `th-openclaw`
**Phase:** 1

| # | Task | Estimate | Status |
|---|------|----------|--------|
| 1.1 | Create `extensions/google-workspace/` directory structure (`src/`, `tests/`, `docs/`) | 5 min | ✅ |
| 1.2 | Write `openclaw.plugin.json` manifest (`id`, `configSchema` ref, tool declarations) | 15 min | ✅ |
| 1.3 | Write JSON config schema (`authProfile`, `scopeProfile`, Drive/Gmail limits) | 20 min | ✅ |
| 1.4 | Bootstrap TypeScript package (`package.json`, `tsconfig.json`, entry point) | 15 min | ✅ |
| 1.5 | Wire plugin into OpenClaw extension discovery (register in workspace or extension index) | 20 min | ✅ |

**Epic total: ~1.25 hours** ✅

---

### EPIC 2 — OAuth & Auth Layer (th-openclaw) ✅ COMPLETE
**Scope:** Google OAuth 2.0 token lifecycle — exchange, refresh, revoke, profile storage
**Repo:** `th-openclaw`
**Phase:** 1

| # | Task | Estimate | Status |
|---|------|----------|--------|
| 2.1 | Implement `GoogleOAuthClient` — authorization URL builder + code→token exchange | 30 min | ✅ |
| 2.2 | Implement token refresh + expiry detection with retry guard | 25 min | ✅ |
| 2.3 | Implement token revoke helper | 10 min | ✅ |
| 2.4 | Map token into OpenClaw auth profile pattern (same shape as existing auth plugins) | 20 min | ✅ |
| 2.5 | Service account JSON key fallback mode | 30 min | ✅ |
| 2.6 | Unit tests for OAuth client (mock Google endpoints) | 30 min | ✅ |

**Epic total: ~2.5 hours** ✅

---

### EPIC 3 — Gmail Read Tools (th-openclaw) ✅ COMPLETE
**Scope:** Register all Phase 1 Gmail read tools with typed schemas and API implementations
**Repo:** `th-openclaw`
**Phase:** 1

| # | Task | Estimate | Status |
|---|------|----------|--------|
| 3.1 | `gmail_search_messages` — query string, pagination, result mapping | 25 min | ✅ |
| 3.2 | `gmail_get_message` — full message retrieval, MIME parsing, body extraction | 30 min | ✅ |
| 3.3 | `gmail_list_threads` — thread list with subject/snippet summaries | 20 min | ✅ |
| 3.4 | `gmail_get_attachment` — attachment download with MIME allowlist + size gate | 25 min | ✅ |
| 3.5 | JSON tool schemas (input/output) for all 4 tools | 20 min | ✅ |
| 3.6 | Unit tests with mocked Gmail API responses | 30 min | ✅ |

**Epic total: ~2.5 hours** ✅

---

### EPIC 4 — Google Drive Read Tools (th-openclaw) ✅ COMPLETE
**Scope:** Register all Phase 1 Drive read tools with typed schemas and API implementations
**Repo:** `th-openclaw`
**Phase:** 1

| # | Task | Estimate | Status |
|---|------|----------|--------|
| 4.1 | `drive_search_files` — query string, MIME filter, folder scope, pagination | 25 min | ✅ |
| 4.2 | `drive_get_file` — metadata retrieval, permissions summary | 20 min | ✅ |
| 4.3 | `drive_download_file` — binary download with size cap + MIME allowlist | 30 min | ✅ |
| 4.4 | `drive_export_google_doc` — export to PDF/plain text via Drive export API | 25 min | ✅ |
| 4.5 | JSON tool schemas for all 4 tools | 20 min | ✅ |
| 4.6 | Unit tests with mocked Drive API responses | 30 min | ✅ |

**Epic total: ~2.5 hours** ✅

---

### EPIC 5 — Plugin Tests, Docs & Safety Defaults (th-openclaw) ✅ COMPLETE
**Scope:** End-to-end integration tests, security defaults validation, setup documentation
**Repo:** `th-openclaw`
**Phase:** 1

| # | Task | Estimate | Status |
|---|------|----------|--------|
| 5.1 | Integration test: auth flow → Gmail search → get message (stubbed Google) | 30 min | ✅ |
| 5.2 | Integration test: auth flow → Drive search → export doc | 25 min | ✅ |
| 5.3 | Log redaction tests (no tokens, no raw message bodies in logs) | 20 min | ✅ |
| 5.4 | Write `docs/extensions/google-workspace.md` — setup guide, config reference, examples | 30 min | ✅ |
| 5.5 | Write security defaults doc (scope profiles, allow/deny, limits) | 20 min | ✅ |

**Epic total: ~2 hours** ✅

---

### EPIC 6 — Cephus Backend Integration (openclaw-agent-factory) ✅ COMPLETE
**Scope:** Register `google_workspace` as a channel type and handle credential storage + validation
**Repo:** `openclaw-agent-factory`
**Phase:** 1

| # | Task | Estimate | Status |
|---|------|----------|--------|
| 6.1 | Add `google_workspace` entry to `ChannelIntegrationService::CHANNEL_CONFIGS` | 10 min | ✅ |
| 6.2 | Implement `validate_google_workspace_credential!` (token ping to Google APIs) | 25 min | ✅ |
| 6.3 | Implement `register_google_workspace_webhook!` (stub for Phase 1, real in Phase 3) | 15 min | ✅ |
| 6.4 | `ChannelCredential` model: add `channel_type :google_workspace` + migration | 20 min | ✅ |
| 6.5 | Rails OAuth callback route: `GET /auth/google_workspace/callback` + controller | 30 min | ✅ |
| 6.6 | OAuth initiation route + state param generation + Faraday token exchange | 30 min | ✅ |
| 6.7 | RSpec tests for service + controller methods | 45 min | ✅ |

**Epic total: ~2.75 hours** ✅

**Deliverables:**
- ✅ `app/models/channel_credential.rb` — `:google_workspace` added to `CHANNEL_TYPES`
- ✅ `app/services/channel_integration_service.rb` — Full credential validation + webhook stub
- ✅ `app/controllers/api/auth/google_workspace_controller.rb` — OAuth authorize + callback + revoke
- ✅ `config/routes.rb` — OAuth routes added
- ✅ `spec/services/channel_integration_service_spec.rb` — 12+ RSpec tests for validation/webhook
- ✅ `spec/requests/api/auth/google_workspace_spec.rb` — Integration tests for OAuth flow

---

### EPIC 7 — Cephus Frontend UI (openclaw-agent-factory) ✅ COMPLETE
**Scope:** Credential setup flow + per-agent tool toggle in agent settings UI
**Repo:** `openclaw-agent-factory`
**Phase:** 1

| # | Task | Estimate | Status |
|---|------|----------|--------|
| 7.1 | Google Workspace card in the integrations/credentials list page | 25 min | ✅ |
| 7.2 | OAuth "Connect Google Account" button → redirect → callback → success state | 35 min | ✅ |
| 7.3 | Credential status indicator (connected / expired / not connected) | 20 min | ✅ |
| 7.4 | Per-agent enable/disable toggle for Google Workspace tools in agent settings | 25 min | ✅ |
| 7.5 | Scope profile selector (read / write) in agent settings | 20 min | ✅ |
| 7.6 | Error state handling (revoked token, missing scopes) | 20 min | ✅ |

**Epic total: ~2.5 hours** ✅

**Deliverables:**
- ✅ `frontend/src/types/channelCredential.ts` — `google_workspace` channel type and scope profile support
- ✅ `frontend/src/services/channelCredentialsApi.ts` — OAuth authorize + revoke API clients
- ✅ `frontend/src/stores/useChannelCredentialStore.ts` — Google OAuth/revoke actions
- ✅ `frontend/src/views/ChannelSetupView.vue` — callback success handling + preselected integration dialog
- ✅ `frontend/src/components/channels/ChannelCredentialsList.vue` — available integration cards, active toggle, revoke action, scope status
- ✅ `frontend/src/components/channels/ChannelCredentialForm.vue` — OAuth connect UI + scope profile selector + write-scope warning
- ✅ `frontend/src/components/channels/__tests__/...` — frontend contract coverage for Google Workspace UX

---

### EPIC 8 — Gmail Write Tools (th-openclaw) — Phase 2 ✅ COMPLETE
**Repo:** `th-openclaw`
**Phase:** 2

| # | Task | Estimate | Status |
|---|------|----------|--------|
| 8.1 | `gmail_send_message` — compose, recipients, attachments, confirmation gate | 35 min | ✅ |
| 8.2 | `gmail_modify_labels` — add/remove labels with label ID resolution | 25 min | ✅ |
| 8.3 | Elevated write scope profile gating (tools inactive without write scope) | 20 min | ✅ |
| 8.4 | Confirmation pattern for `gmail_send_message` (agent must verify before send) | 25 min | ✅ |
| 8.5 | Unit + integration tests for write tools | 30 min | ✅ |

**Epic total: ~2.25 hours** ✅

**Deliverables:**
- ✅ `extensions/google-workspace/src/gmail-schemas.ts` — write actions (`send_message`, `modify_labels`) added
- ✅ `extensions/google-workspace/src/gmail.ts` — write-scope gating + send confirmation token gate + recipient domain policy
- ✅ `extensions/google-workspace/src/gmail.test.ts` — coverage for scope gating, confirmation flow, allowlist policy, send/modify success paths
- ✅ `extensions/google-workspace/docs/setup.md` — updated tool reference and write-action safety behavior

---

### EPIC 9 — Drive Write Tools (th-openclaw) — Phase 2 ✅ COMPLETE
**Repo:** `th-openclaw`
**Phase:** 2

| # | Task | Estimate | Status |
|---|------|----------|--------|
| 9.1 | `drive_upload_file` — multipart upload, MIME type detection, size cap | 35 min | ✅ |
| 9.2 | `drive_create_folder` — folder creation with parent resolution | 20 min | ✅ |
| 9.3 | `drive_share_file` — share with domain allowlist enforcement | 30 min | ✅ |
| 9.4 | Unit + integration tests | 25 min | ✅ |

**Epic total: ~1.75 hours** ✅

**Deliverables:**
- ✅ `extensions/google-workspace/src/drive-schemas.ts` — write actions (`upload_file`, `create_folder`, `share_file`) added
- ✅ `extensions/google-workspace/src/drive.ts` — write-scope gating, upload/create implementations, and share allowlist policy enforcement
- ✅ `extensions/google-workspace/src/config-schema.ts` — `drive.allowedShareDomains` policy control
- ✅ `extensions/google-workspace/src/drive.test.ts` — coverage for scope gating and write action paths
- ✅ `extensions/google-workspace/docs/setup.md` — Drive write action and policy documentation

---

### EPIC 10 — Cephus Write Scope UI (openclaw-agent-factory) — Phase 2 ✅ COMPLETE
**Repo:** `openclaw-agent-factory`
**Phase:** 2

| # | Task | Estimate | Status |
|---|------|----------|--------|
| 10.1 | Write scope opt-in step in OAuth grant flow (additional consent screen) | 25 min | ✅ |
| 10.2 | Write-scope badge / warning in per-agent tool settings | 15 min | ✅ |
| 10.3 | Audit log surface for write actions in deployment events view | 30 min | ✅ |

**Epic total: ~1.25 hours** ✅

**Deliverables:**
- ✅ `frontend/src/components/channels/ChannelCredentialForm.vue` — explicit write-scope acknowledgment gate before OAuth start
- ✅ `frontend/src/components/channels/ChannelCredentialsList.vue` — write-scope warning badge and risk copy in per-agent settings
- ✅ `app/models/agent.rb` — deployment-time write-scope audit event creation
- ✅ `app/controllers/api/deployments_controller.rb` + `frontend/src/components/deployment/DeploymentEventsTimeline.vue` — write-access audit event surfacing in deployment status timeline

---

### EPIC 11 — Gmail Pub/Sub Event Bridge (Phase 3) ✅ IMPLEMENTED
**Repos:** `th-openclaw` + `openclaw-agent-factory`
**Phase:** 3

| # | Task | Estimate | Status |
|---|------|----------|--------|
| 11.1 | `th-openclaw`: Gmail Pub/Sub event adapter (maps push notification → tool context) | 40 min | ✅ |
| 11.2 | `th-openclaw`: Task template "new email → triage agent" | 25 min | ✅ |
| 11.3 | `openclaw-agent-factory`: Real `register_google_workspace_webhook!` implementation | 30 min | ✅ |
| 11.4 | `openclaw-agent-factory`: `POST /hooks/google_workspace/gmail` endpoint + routing | 25 min | ✅ |
| 11.5 | End-to-end test: push notification → agent triggered → Gmail tool called | 40 min | ✅ |
| 11.6 | Docs: automation patterns for email triage and Drive workflows | 25 min | ✅ |

**Epic total: ~3 hours** ✅

**Deliverables:**
- ✅ `extensions/google-workspace/src/gmail-pubsub-adapter.ts` + test coverage
- ✅ `extensions/google-workspace/docs/templates/new-email-triage-agent.md`
- ✅ `app/services/channel_integration_service.rb` real Gmail watch registration (`register_google_workspace_webhook!`)
- ✅ `config/routes.rb` + `app/controllers/hooks/google_workspace_controller.rb` (`POST /hooks/google_workspace/gmail`)
- ✅ `app/jobs/process_google_workspace_gmail_webhook_job.rb` + request/job specs for event-triggered dispatch
- ✅ `docs/automation/google-workspace-automation-patterns.md`

---

## Summary Table

| Epic | Description | Repo | Phase | AI Agent Estimate | Status |
|------|-------------|------|-------|-------------------|--------|
| 1 | Plugin scaffold | th-openclaw | 1 | 1.25 h | ✅ DONE |
| 2 | OAuth & auth layer | th-openclaw | 1 | 2.5 h | ✅ DONE |
| 3 | Gmail read tools | th-openclaw | 1 | 2.5 h | ✅ DONE |
| 4 | Drive read tools | th-openclaw | 1 | 2.5 h | ✅ DONE |
| 5 | Tests, docs, safety defaults | th-openclaw | 1 | 2 h | ✅ DONE |
| 6 | Cephus backend integration | openclaw-agent-factory | 1 | 2.75 h | ✅ DONE |
| 7 | Cephus frontend UI | openclaw-agent-factory | 1 | 2.5 h | ✅ DONE |
| **Phase 1 total** | | | | **~18 hours** | **✅ COMPLETE** |
| 8 | Gmail write tools | th-openclaw | 2 | 2.25 h | ✅ DONE |
| 9 | Drive write tools | th-openclaw | 2 | 1.75 h | ✅ DONE |
| 10 | Cephus write scope UI | openclaw-agent-factory | 2 | 1.25 h | ✅ DONE |
| **Phase 2 total** | | | | **~5.25 hours** | **✅ COMPLETE** |
| 11 | Gmail Pub/Sub event bridge | both | 3 | 3 h | ✅ DONE |
| **Phase 3 total** | | | | **~3 hours** | **✅ COMPLETE** |
| **Grand total** | | | | **~26.25 hours** | **✅ ~100% complete (Epics 1–11)** |

> **Note on AI agent estimates:** These assume an AI agent with tool access (code generation, file editing, test runner feedback loop) working without interruption. A human developer would multiply these by 3–5× due to context switching, research time, and manual testing overhead. Cross-repo coordination (Epics 6–7 depending on 1–5) keeps phases sequential — Phase 2 cannot start before Phase 1 integration tests pass.

