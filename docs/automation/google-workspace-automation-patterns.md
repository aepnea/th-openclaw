# Google Workspace Automation Patterns

This guide documents practical automation patterns using Gmail and Drive tools with webhook/event triggers.

## Pattern 1: New Email -> Inbox Triage

### Trigger
- Gmail Pub/Sub push event
- Adapter: `extensions/google-workspace/src/gmail-pubsub-adapter.ts`

### Flow
1. Parse Pub/Sub event into normalized context (`emailAddress`, `historyId`).
2. Trigger agent hook run with triage prompt.
3. Agent calls `google_gmail` (`search_messages`) for recent inbox activity.
4. Agent returns ranked triage summary and recommendations.

### Best Practices
- Keep query bounded: `newer_than:2d in:inbox`.
- Enforce response format with sections (`urgent`, `reply-needed`, `FYI`).
- Use read-only scope by default.

## Pattern 2: New Email -> Save Attachments To Drive

### Trigger
- Inbox triage identifies attachment-worthy message.

### Flow
1. Agent fetches attachment metadata (`google_gmail`, `get_attachment`).
2. Validate file type and size policy.
3. Upload to Drive via `google_drive` (`upload_file`) into a dedicated folder.
4. Optionally share file using approved domains policy.

### Best Practices
- Restrict MIME types and max file size.
- Enforce Drive share-domain allowlist.
- Add naming convention per workflow, e.g., `yyyy-mm-dd_sender_subject`.

## Pattern 3: Follow-up Queue From Starred/Labelled Emails

### Trigger
- Scheduled run or event-triggered run after label changes.

### Flow
1. Search for labelled items (e.g., follow-up queue label).
2. Summarize pending actions and deadlines.
3. Produce daily brief for operator.

### Best Practices
- Prefer label-driven queues over broad keyword search.
- Keep summary deterministic and compact.
- Emit references (`threadId`, `messageId`) for traceability.

## Security and Safety
- Require write-scope opt-in for any Gmail send or Drive share action.
- Keep audit events for write-scope deployments and webhook-triggered runs.
- Validate webhook source and map events through a known `webhook_id`.
