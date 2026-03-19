import { z } from "zod";

export const GoogleWorkspaceOAuth2AuthSchema = z.object({
  type: z.literal("oauth2"),
  clientId: z.string({ description: "Google OAuth2 client ID" }),
  clientSecret: z.string({ description: "Google OAuth2 client secret" }),
  accessToken: z.string({ description: "Google access token" }),
  refreshToken: z.string({ description: "Google refresh token" }),
  expiryDate: z.number().optional().describe("Token expiry timestamp (ms since epoch)"),
});

export const GoogleWorkspaceServiceAccountAuthSchema = z.object({
  type: z.literal("service_account"),
  keyFile: z.string().optional().describe("Path to service account JSON key file"),
  credentials: z.record(z.unknown()).optional().describe("Service account credentials (inline)"),
});

export const GoogleWorkspaceConfigSchema = z.object({
  auth: z.union([GoogleWorkspaceOAuth2AuthSchema, GoogleWorkspaceServiceAccountAuthSchema]),
  scopeProfile: z.enum(["read", "write"]).default("read").describe("Scope profile: 'read' (default) or 'write'"),
  drive: z
    .object({
      maxDownloadMb: z.number().default(20).describe("Max file download size in MB"),
      allowedMimePrefixes: z
        .array(z.string())
        .default(["text/", "application/pdf", "application/vnd.google-apps."])
        .describe("Allowed MIME type prefixes for downloads"),
      allowedShareDomains: z
        .array(z.string())
        .default([])
        .describe("Allowed domains for share_file (empty = allow all domains)"),
    })
    .default({}),
  gmail: z
    .object({
      maxAttachmentMb: z.number().default(20).describe("Max attachment download size in MB"),
      allowedRecipientDomains: z
        .array(z.string())
        .default([])
        .describe("Allowed recipient domains for send (empty = allow all when write scope enabled)"),
    })
    .default({}),
});

export type GoogleWorkspaceConfig = z.infer<typeof GoogleWorkspaceConfigSchema>;
