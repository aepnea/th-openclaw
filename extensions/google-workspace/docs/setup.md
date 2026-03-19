# Google Workspace Plugin — Setup Guide

## Overview

The `@openclaw/google-workspace` plugin adds Gmail and Google Drive access to OpenClaw agents.

**Current Phase:** 3 (eventing-enabled) — Gmail/Drive read + write-gated actions + Gmail Pub/Sub adapter

## Prerequisites

1. **Google Cloud Project** with APIs enabled:
   - Gmail API (gmail.googleapis.com)
   - Google Drive API (drive.googleapis.com)

2. **Authentication method** (choose one):
   - **OAuth2 (user credentials)** — for personal/workspace accounts
   - **Service Account** — for programmatic/org-level installs

## Setup: OAuth2 (Recommended)

### 1. Create OAuth2 Client in Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create/select a project
3. Enable **Gmail API** and **Google Drive API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID (Web application)**
5. Set authorized redirect URIs to your Cephus instance (provided by Cephus UI during credential setup)
   - Example: `https://your-cephus-domain.com/auth/google_workspace/callback`
6. Save **Client ID** and **Client Secret** — you'll paste these in Cephus

### 2. Connect in Cephus Agent Factory

1. In Cephus Home dashboard, go to **Integrations** → **Credentials**
2. Click **Add Integration** → **Google Workspace**
3. Paste your **Client ID** and **Client Secret**
4. Click **Connect Google Account** — you'll be redirected to Google login
5. Authorize the scopes (Gmail, Drive read-only)
6. Cephus stores the tokens securely and refreshes them automatically

### 3. Assign to Agents

1. In **Agent Settings**, under **Tools**, enable **Google Workspace**
2. The `google_gmail` and `google_drive` tools are now available to your agent
3. Deploy the agent — the plugin will load with your credentials

## Setup: Service Account

For organizational/programmatic setups:

### 1. Create Service Account

1. In Google Cloud Console: **Credentials** → **Create Credentials** → **Service Account**
2. Grant the service account:
   - Gmail API Admin (if accessing Gmail via delegated authority)
   - Google Drive Admin (if accessing shared drives)
3. Create a JSON key file
4. Download the key

### 2. In the Plugin Config

Set environment or config variable:

```typescript
{
  auth: {
    type: "service_account",
    keyFile: "/path/to/service-account-key.json"
    // OR inline credentials:
    // credentials: { /* service account JSON */ }
  },
  scopeProfile: "read"
}
```

> **Note:** Service accounts access Google APIs directly (no user context). Gmail operations require Gmail Account delegation (if accessing user mailboxes).

## Tool Reference

### google_gmail

**Actions:**
- `search_messages`: Search Gmail with query language
  - Query examples: `from:alice@example.com`, `subject:report`, `is:unread`
- `get_message`: Retrieve full message details (headers, body, attachments list)
- `list_threads`: List conversation threads
- `get_attachment`: Download a specific attachment (gated by `maxAttachmentMb`)
- `send_message`: Send an email (requires `scopeProfile: "write"` + explicit confirmation token)
- `modify_labels`: Add/remove Gmail labels from a message (requires `scopeProfile: "write"`)

**Limits:**
- Read-only by default (`scopeProfile: "read"`)
- Write actions only available with `scopeProfile: "write"`
- `send_message` requires `confirmSend: true` and `confirmationToken: "SEND_EMAIL"`
- Optional recipient domain policy via `gmail.allowedRecipientDomains`
- Max attachment download: 20 MB (configurable)
- Max results per query: 100 messages

### google_drive

**Actions:**
- `search_files`: Search Drive files with Drive API query language
  - Query examples: `name contains "report"`, `mimeType = "application/pdf"`
- `get_file`: Retrieve file metadata (size, owner, created time, etc.)
- `download_file`: Download a file (gated by `maxDownloadMb` and MIME allowlist)
- `export_google_doc`: Export a Google Workspace document (Doc, Sheet, Slide, etc.) to PDF, DOCX, etc.
- `upload_file`: Upload a file to Drive (requires `scopeProfile: "write"`)
- `create_folder`: Create a folder in Drive (requires `scopeProfile: "write"`)
- `share_file`: Share a file with user/group/domain (requires `scopeProfile: "write"`)

**Limits:**
- Read-only by default (`scopeProfile: "read"`)
- Write actions only available with `scopeProfile: "write"`
- Share policy can be constrained with `drive.allowedShareDomains`
- Max download: 20 MB (configurable)
- MIME types allowed by default: `text/*`, `application/pdf`, `application/vnd.google-apps.*`

## Configuration Reference

```json5
{
  auth: {
    // Option 1: OAuth2 user credentials
    type: "oauth2",
    clientId: "your-client-id.apps.googleusercontent.com",
    clientSecret: "your-client-secret",
    accessToken: "ya29...",        // Provided by Cephus OAuth flow
    refreshToken: "1//...",        // Provided by Cephus OAuth flow
    expiryDate: 1711234567890,    // Auto-managed by token refresh
    
    // Option 2: Service account
    // type: "service_account",
    // keyFile: "/path/to/key.json",
    // OR
    // credentials: { /* JSON key content */ }
  },

  scopeProfile: "read",  // "read" (default) or "write" (Phase 2+)

  drive: {
    maxDownloadMb: 20,
    // MIME type prefixes allowed for download (others blocked)
    allowedMimePrefixes: [
      "text/",
      "application/pdf",
      "application/vnd.google-apps."
    ],
    // Allowed domains for share_file (empty = allow all)
    allowedShareDomains: []
  },

  gmail: {
    maxAttachmentMb: 20,
    // Domains allowed for email send (Phase 2, empty = allow all)
    allowedRecipientDomains: []
  }
}
```

## Troubleshooting

### "Failed to obtain Google Workspace access token"

- **OAuth2:** Check that tokens are valid (not expired/revoked). Cephus auto-refreshes, but if refresh fails, re-authenticate.
- **Service Account:** Verify the JSON key is valid and has not been rotated/deleted in Google Cloud Console.

### "File size exceeds limit"

- Increase `drive.maxDownloadMb` or `gmail.maxAttachmentMb` in config (careful with large files).

### "MIME type not in allowed list"

- Add the file's MIME type prefix to `drive.allowedMimePrefixes` (defaults: `text/`, `application/pdf`, `application/vnd.google-apps.*`).

### Permission denied errors

- **OAuth2:** Scope may not have been requested properly. Re-authenticate and authorize full scopes.
- **Service Account:** Verify the service account has roles: `Gmail API Admin`, `Drive API Admin` (if needed).

## Security Considerations

See [security.md](./security.md) for detailed threat model and mitigation strategies.

**Key points:**
- Access tokens are never logged in plaintext
- Read-only scopes are enforced in Phase 1 (no accidental writes)
- MIME type and size allowlists prevent large/binary file exfiltration
- Write operations (Phase 2+) will require explicit confirmation gates

## Automation (Phase 3)

- Gmail Pub/Sub adapter: `src/gmail-pubsub-adapter.ts`
- Email triage template: `docs/templates/new-email-triage-agent.md`
- Cross-workflow patterns: `../../../docs/automation/google-workspace-automation-patterns.md`
