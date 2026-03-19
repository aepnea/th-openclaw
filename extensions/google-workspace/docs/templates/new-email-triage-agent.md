# Task Template: New Email -> Triage Agent

## Trigger
- Source: Gmail Pub/Sub push notification
- Event adapter: `adaptGmailPubSubEvent()` from `src/gmail-pubsub-adapter.ts`

## Goal
When new inbox activity arrives, trigger an agent run that:
1. Pulls recent inbox messages using `google_gmail`.
2. Produces a priority-ranked triage summary.
3. Suggests concrete follow-up actions.

## Suggested Hook Prompt
```text
New Gmail push event received. Perform inbox triage.
Context: emailAddress={{emailAddress}} historyId={{historyId}}
Call google_gmail with action=search_messages and query="newer_than:2d in:inbox".
Return top actionable emails and suggested next steps.
```

## Suggested Tool Call
```json
{
  "action": "search_messages",
  "query": "newer_than:2d in:inbox",
  "maxResults": 25
}
```

## Output Contract
- `high_priority`: list of urgent emails
- `needs_reply`: list of emails that likely need a response
- `informational`: low urgency updates
- `next_actions`: recommended actions for the user/agent

## Safety Notes
- Keep default scope profile as `read` for triage-only workflows.
- If write actions are enabled, require explicit human confirmation before sending mail.
