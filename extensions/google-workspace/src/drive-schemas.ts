import { Type, type Static } from "@sinclair/typebox";

/**
 * Google Drive tool parameters schema using TypeBox.
 * Supports actions: search_files, get_file, download_file, export_google_doc,
 * upload_file, create_folder, share_file
 */
export const DriveSchema = Type.Union([
  // Search files in Drive
  Type.Object(
    {
      action: Type.Literal("search_files"),
      query: Type.String({
        description:
          "Drive search query (e.g., 'name contains \"report\"', 'mimeType = \"application/vnd.google-apps.document\"')",
      }),
      pageSize: Type.Optional(Type.Number({ description: "Page size (1-1000, default 10)" })),
      pageToken: Type.Optional(Type.String({ description: "Pagination token from previous response" })),
      corpora: Type.Optional(
        Type.Union(
          [Type.Literal("user"), Type.Literal("drive"), Type.Literal("allDrives")],
          { description: "Search scope (default: user)" },
        ),
      ),
    },
    { description: "Search for files in Google Drive" },
  ),

  // Get file metadata
  Type.Object(
    {
      action: Type.Literal("get_file"),
      fileId: Type.String({ description: "Google Drive file ID" }),
    },
    { description: "Get metadata for a file in Google Drive" },
  ),

  // Download a file
  Type.Object(
    {
      action: Type.Literal("download_file"),
      fileId: Type.String({ description: "Google Drive file ID" }),
      mimeType: Type.Optional(
        Type.String({ description: "Target MIME type if conversion needed" }),
      ),
    },
    { description: "Download a file (limited by maxDownloadMb config and MIME allowlist)" },
  ),

  // Export a Google Doc (Sheets, Docs, Slides, etc.)
  Type.Object(
    {
      action: Type.Literal("export_google_doc"),
      fileId: Type.String({ description: "Google Workspace file ID (Doc, Sheet, Slide, etc.)" }),
      mimeType: Type.String({
        description: "Export format (e.g., application/pdf, text/plain, application/vnd.openxmlformats-officedocument.wordprocessingml.document)",
      }),
    },
    { description: "Export a Google Workspace document to another format (PDF, DOCX, etc.)" },
  ),

  // Upload a file (write scope required)
  Type.Object(
    {
      action: Type.Literal("upload_file"),
      name: Type.String({ description: "Filename to create in Drive" }),
      mimeType: Type.String({ description: "MIME type for uploaded file" }),
      contentBase64: Type.String({ description: "File content as base64 string" }),
      parentFolderId: Type.Optional(Type.String({ description: "Optional parent folder ID" })),
      description: Type.Optional(Type.String({ description: "Optional file description" })),
    },
    { description: "Upload a file to Google Drive (requires scopeProfile=write)" },
  ),

  // Create a folder (write scope required)
  Type.Object(
    {
      action: Type.Literal("create_folder"),
      name: Type.String({ description: "Folder name" }),
      parentFolderId: Type.Optional(Type.String({ description: "Optional parent folder ID" })),
    },
    { description: "Create a folder in Google Drive (requires scopeProfile=write)" },
  ),

  // Share file (write scope required + allowlist enforcement)
  Type.Object(
    {
      action: Type.Literal("share_file"),
      fileId: Type.String({ description: "Drive file ID to share" }),
      type: Type.Union(
        [Type.Literal("user"), Type.Literal("group"), Type.Literal("domain"), Type.Literal("anyone")],
        { description: "Permission type" },
      ),
      role: Type.Union(
        [Type.Literal("reader"), Type.Literal("commenter"), Type.Literal("writer")],
        { description: "Permission role" },
      ),
      emailAddress: Type.Optional(Type.String({ description: "Email (required for user/group)" })),
      domain: Type.Optional(Type.String({ description: "Domain (required for domain type)" })),
      sendNotificationEmail: Type.Optional(Type.Boolean({ description: "Send notification email (default true)" })),
      message: Type.Optional(Type.String({ description: "Optional notification message" })),
    },
    { description: "Share a file in Drive (requires scopeProfile=write and domain allowlist policy)" },
  ),
]);

export type DriveParams = Static<typeof DriveSchema>;
