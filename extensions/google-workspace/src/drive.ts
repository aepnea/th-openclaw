import { drive_v3 } from "googleapis";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createGoogleAuthClient } from "./auth.js";
import { DriveSchema, type DriveParams } from "./drive-schemas.js";
import type { GoogleWorkspaceConfig } from "./config-schema.js";

/**
 * Helper to format JSON response for agent tools
 */
function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * Check if MIME type is allowed based on allowlist
 */
function isMimeTypeAllowed(mimeType: string | undefined, allowedPrefixes: string[]): boolean {
  if (!mimeType) return false;
  return allowedPrefixes.some((prefix) => mimeType.startsWith(prefix));
}

function assertWriteScope(config: GoogleWorkspaceConfig) {
  if (config.scopeProfile !== "write") {
    throw new Error("Action requires scopeProfile=write");
  }
}

function decodeBase64ToUint8Array(contentBase64: string): Uint8Array {
  const normalized = contentBase64.replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function extractEmailDomain(email?: string): string | null {
  if (!email) return null;
  const idx = email.lastIndexOf("@");
  if (idx <= 0 || idx === email.length - 1) return null;
  return email.slice(idx + 1).toLowerCase();
}

function enforceShareDomainPolicy(
  config: GoogleWorkspaceConfig,
  type: "user" | "group" | "domain" | "anyone",
  emailAddress?: string,
  domain?: string,
) {
  const allowed = config.drive.allowedShareDomains ?? [];
  if (allowed.length === 0) return;

  const allowedSet = new Set(allowed.map((d: string) => d.toLowerCase()));

  if (type === "user" || type === "group") {
    const emailDomain = extractEmailDomain(emailAddress);
    if (!emailDomain || !allowedSet.has(emailDomain)) {
      throw new Error(`Share denied by policy. Allowed domains: ${allowed.join(", ")}`);
    }
    return;
  }

  if (type === "domain") {
    const normalizedDomain = domain?.toLowerCase();
    if (!normalizedDomain || !allowedSet.has(normalizedDomain)) {
      throw new Error(`Domain share denied by policy. Allowed domains: ${allowed.join(", ")}`);
    }
    return;
  }

  throw new Error("Sharing type 'anyone' is blocked when allowedShareDomains policy is configured");
}

/**
 * Register Drive tools:
 * - Read: search_files, get_file, download_file, export_google_doc
 * - Write (scopeProfile=write): upload_file, create_folder, share_file
 */
export async function registerDriveTools(api: OpenClawPluginApi, config: GoogleWorkspaceConfig) {
  const createDriveService = async () => {
    const authClient = await createGoogleAuthClient(config);
    return new drive_v3.Drive({ auth: authClient });
  };

  api.registerTool(
    {
      name: "google_drive",
      label: "Google Drive",
      description:
        "Google Drive operations. Read actions: search_files, get_file, download_file, export_google_doc. Write actions (scopeProfile=write): upload_file, create_folder, share_file.",
      parameters: DriveSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as DriveParams;
        try {
          const drive = await createDriveService();

          switch (p.action) {
            case "search_files": {
              const res = await drive.files.list({
                q: p.query,
                pageSize: Math.min(p.pageSize ?? 10, 1000),
                pageToken: p.pageToken,
                corpora: p.corpora ?? "user",
                spaces: "drive",
                fields: "files(id,name,mimeType,size,createdTime,modifiedTime,owners),nextPageToken",
              });

              return json({
                files: res.data.files ?? [],
                nextPageToken: res.data.nextPageToken,
              });
            }

            case "get_file": {
              const res = await drive.files.get({
                fileId: p.fileId,
                fields:
                  "id,name,mimeType,size,createdTime,modifiedTime,owners,webViewLink,description",
              });

              return json({
                id: res.data.id,
                name: res.data.name,
                mimeType: res.data.mimeType,
                size: res.data.size,
                createdTime: res.data.createdTime,
                modifiedTime: res.data.modifiedTime,
                owners: res.data.owners,
                webViewLink: res.data.webViewLink,
                description: res.data.description,
              });
            }

            case "download_file": {
              const metadata = await drive.files.get({
                fileId: p.fileId,
                fields: "id,name,mimeType,size",
              });

              const sizeBytes = parseInt(metadata.data.size ?? "0", 10);
              const maxBytes = (config.drive.maxDownloadMb ?? 20) * 1024 * 1024;
              const mimeAllowed = isMimeTypeAllowed(
                p.mimeType || metadata.data.mimeType,
                config.drive.allowedMimePrefixes ?? [],
              );

              if (sizeBytes > maxBytes) {
                return json({
                  error: `File size (${sizeBytes} bytes) exceeds limit (${maxBytes} bytes)`,
                });
              }

              if (!mimeAllowed) {
                return json({
                  error: `File MIME type ${metadata.data.mimeType} not in allowed list: ${config.drive.allowedMimePrefixes?.join(", ")}`,
                });
              }

              const res = await drive.files.get(
                { fileId: p.fileId, alt: "media" },
                { responseType: "arraybuffer" },
              );

              // Return file metadata + indicator that content was downloaded (don't expose full content in logs)
              return json({
                fileId: metadata.data.id,
                name: metadata.data.name,
                mimeType: metadata.data.mimeType,
                size: sizeBytes,
                downloadedBytes: (res.data as ArrayBuffer).byteLength,
                // Don't include actual file content in response for security/logging
              });
            }

            case "export_google_doc": {
              const res = await drive.files.export(
                {
                  fileId: p.fileId,
                  mimeType: p.mimeType,
                },
                { responseType: "arraybuffer" },
              );

              const contentBytes = (res.data as ArrayBuffer).byteLength;
              const maxBytes = (config.drive.maxDownloadMb ?? 20) * 1024 * 1024;

              if (contentBytes > maxBytes) {
                return json({
                  error: `Exported content (${contentBytes} bytes) exceeds limit (${maxBytes} bytes)`,
                });
              }

              return json({
                fileId: p.fileId,
                exportMimeType: p.mimeType,
                exportedBytes: contentBytes,
                // Don't include actual file content in response for security/logging
              });
            }

            case "upload_file": {
              assertWriteScope(config);

              const bytes = decodeBase64ToUint8Array(p.contentBase64);
              const maxBytes = (config.drive.maxDownloadMb ?? 20) * 1024 * 1024;

              if (bytes.byteLength > maxBytes) {
                return json({
                  error: `Upload content (${bytes.byteLength} bytes) exceeds limit (${maxBytes} bytes)`,
                });
              }

              const createRes = await drive.files.create({
                requestBody: {
                  name: p.name,
                  mimeType: p.mimeType,
                  description: p.description,
                  parents: p.parentFolderId ? [p.parentFolderId] : undefined,
                },
                media: {
                  mimeType: p.mimeType,
                  body: bytes,
                },
                fields: "id,name,mimeType,size,parents,webViewLink",
              });

              return json({
                uploaded: true,
                id: createRes.data.id,
                name: createRes.data.name,
                mimeType: createRes.data.mimeType,
                size: createRes.data.size,
                parents: createRes.data.parents,
                webViewLink: createRes.data.webViewLink,
              });
            }

            case "create_folder": {
              assertWriteScope(config);

              const createRes = await drive.files.create({
                requestBody: {
                  name: p.name,
                  mimeType: "application/vnd.google-apps.folder",
                  parents: p.parentFolderId ? [p.parentFolderId] : undefined,
                },
                fields: "id,name,mimeType,parents,webViewLink",
              });

              return json({
                created: true,
                id: createRes.data.id,
                name: createRes.data.name,
                mimeType: createRes.data.mimeType,
                parents: createRes.data.parents,
                webViewLink: createRes.data.webViewLink,
              });
            }

            case "share_file": {
              assertWriteScope(config);

              if ((p.type === "user" || p.type === "group") && !p.emailAddress) {
                return json({ error: "emailAddress is required for share type user/group" });
              }

              if (p.type === "domain" && !p.domain) {
                return json({ error: "domain is required for share type domain" });
              }

              enforceShareDomainPolicy(config, p.type, p.emailAddress, p.domain);

              const permissionRes = await drive.permissions.create({
                fileId: p.fileId,
                sendNotificationEmail: p.sendNotificationEmail ?? true,
                emailMessage: p.message,
                requestBody: {
                  type: p.type,
                  role: p.role,
                  emailAddress: p.emailAddress,
                  domain: p.domain,
                },
                fields: "id,type,role,emailAddress,domain",
              });

              return json({
                shared: true,
                fileId: p.fileId,
                permission: permissionRes.data,
              });
            }

            default:
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return json({ error: `Unknown Drive action: ${(p as any).action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "google_drive" },
  );

  api.logger?.info?.("google-workspace: Registered google_drive tool");
}
