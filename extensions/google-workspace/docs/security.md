# Google Workspace Plugin — Security & Safety Controls

## Risk Model

This document outlines security risks and mitigation strategies for the Google Workspace plugin.

## Threat: Token Exposure

**Severity:** CRITICAL  
**Surface:** Access tokens and refresh tokens stored in Cephus, transmitted to OpenClaw agents  
**Mitigation:**
- Tokens are NEVER logged in plaintext; auth module sanitizes all logging
- Tokens stored encrypted at rest in Cephus database (managed by Cephus)
- Tokens transmitted via HTTPS only
- Short-lived access tokens (1 hour default via google-auth-library)
- Refresh tokens stored only if user opted in; can be revoked via Cephus UI

## Threat: Scope Explosion (Over-Privileged Tokens)

**Severity:** HIGH  
**Surface:** OAuth2 scopes granted to token can be broader than needed  
**Mitigation:**
- Phase 1: ONLY read-only scopes requested (`gmail.readonly`, `drive.readonly`)
- Phase 2 (write): Write scopes optional, explicitly selected by agent admin
- Cephus UI makes scope selection obvious (checkbox: "Enable Gmail Send?")
- Service account credentials restricted by Google Cloud IAM roles

## Threat: Data Exfiltration (Large File Access)

**Severity:** HIGH  
**Surface:** Agent could download large email bodies or Drive files  
**Mitigation:**
- `maxAttachmentMb`: Default 20 MB, configurable per deployment
- `maxDownloadMb`: Default 20 MB, configurable per deployment
- `allowedMimePrefixes`: Default is text, PDF, Google Workspace only (blocks EXE, ZIP, etc.)
- Tool responses truncate file content in logs (first 10 KB only for debugging)

## Threat: Unintended Email Send (Phase 2+)

**Severity:** MEDIUM  
**Surface:** Agent gets write scope, could send email on bad instruction  
**Mitigation:**
- Phase 1: No send tools exposed (read-only)
- Phase 2: `gmail_send_message` is optional, explicit tool enable-in Cephus
- Confirmation gate (planned): Agent must invoke `gmail_confirm_send()` before actual send
- Sender domain allowlist: `allowedRecipientDomains` restricts who can receive (empty = allow all for now)

## Threat: Account Takeover (Service Account Compromise)

**Severity:** CRITICAL  
**Surface:** Service account JSON key stored on disk or in config  
**Mitigation:**
- Service accounts are org-managed, not recommended for multi-tenant SaaS unless air-gapped
- JSON key should be kept in secure vault (e.g., HashiCorp Vault, AWS Secrets Manager)
- Cephus can inject key via environment variable at deployment time
- No service account credentials should be stored in version control
- Consider using Google Cloud IAM Workload Identity in Kubernetes deployments

## Threat: Unauthorized Integration Access

**Severity:** MEDIUM  
**Surface:** Non-admin users could create agents with Google tools  
**Mitigation:**
- Cephus RBAC controls agent creation (admin-only by default)
- Agent settings UI requires admin approval to enable Google Workspace
- Integration credentials are workspace-leveclass (single shared credential or org-level)
- Per-agent tool enable/disable is separate from integration setup

## Threat: Timing/Traffic Analysis

**Severity:** LOW  
**Surface:** Attacker observes API calls to Gmail/Drive to infer user behavior  
**Mitigation:**
- Out of scope for Phase 1
- Future: Rate limiting, jitter on requests
- Future: Local caching with TTL to avoid repeated API calls

## Design Principles

### 1. Read-Only by Default
- Phase 1 has zero write capabilities
- Write tools are opt-in and clearly labeled
- Service account can still perform writes if configured by admin

### 2. Explicit Scope Declaration
- User sees exactly which scopes are requested during OAuth
- Write scope requires separate, explicit authorization step
- Cephus admin can revoke scopes by removing integration

### 3. Bounded Access
- All downloads limited by size (MB)
- All searches limited by result count (100 max)
- All file access limited by MIME type allowlist

### 4. No Shell/Command Injection
- All tool inputs are typed with TypeBox JSON schemas
- No code execution paths (tools call APIs, not shell)
- SQL injection not applicable (Google APIs, no direct DB access)

### 5. Audit & Redaction
- All tool calls logged with action name and result summary
- Never log in plaintext: tokens, raw email bodies, raw file content
- Logs include: action taken, file IDs, message counts, errors
- Logs exclude: token values, message text, attachment data

## Compliance Considerations

### GDPR
- Plugin operates on user's own Google Workspace account (user-initiated)
- No data retention: agents read, do not store email/files in OpenClaw
- Tokens can be revoked via Cephus UI (right to disconnect)
- Consider: Data Processing Addendum if Cephus is used for EU customer data

### SOC 2 / FedRAMP
- Out of scope for Phase 1; plan for Phase 2+
- Audit trails in Cephus (who enabled integration, when)
- Encryption at rest and in transit (handled by Cephus/Google)

## Testing & Validation

### Unit Tests
- Auth token refresh with expired token
- MIME type allowlist enforcement
- Size limit enforcement
- Error handling with malformed API responses

### Integration Tests (Stubbed)
- Config schema validation (valid/invalid configs)
- Tool parameter validation (TypeBox schemas)
- Log redaction (no tokens in output)

### Manual Security Testing (future)
- OAuth flow with denied permissions
- Service account role restrictions
- Rate limiting under load
- Token revocation behavior

## Future Mitigations (Phase 2+)

1. **Confirmation Gates:** Email send requires secondary confirmation
2. **Rate Limiting:** Throttle API calls to prevent DoS
3. **Caching:** Local result cache to reduce API calls
4. **Audit Dashboard:** Cephus UI shows integration usage (APIs called, data accessed)
5. **Webhook Events:** Gmail Pub/Sub events to reduce polling
6. **Scope Delegation:** Per-agent subsets of available tools (not just enable/disable)

## Incident Response

If a token is compromised:

1. **Cephus Admin:** Go to Google Workspace credential → *Revoke*
2. **Result:** Tokens are revoked with Google, agents lose access
3. **Recovery:** Re-authenticate OAuth and reconnect
4. **Audit:** Cephus logs which credentials were active when

If a service account key is compromised:

1. **Cloud Admin:** Rotate key in Google Cloud Console
2. **Deployment:** Update Cephus with new key (environment variable, secret manager)
3. **Key Destruction:** Delete compromised key in GCP
4. **Audit:** Review API audit logs in GCP for unauthorized access

## Reporting Security Issues

If you discover a security issue with this plugin:

1. **Do NOT** file a public GitHub issue
2. Email security concerns to `security@example.com` (TBD)
3. Include: description, steps to reproduce, severity assessment
4. Our team will acknowledge within 48 hours and provide remediation timeline
