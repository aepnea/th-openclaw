import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { GoogleWorkspaceConfigSchema, type GoogleWorkspaceConfig } from "./src/config-schema.js";
import { registerGmailTools } from "./src/gmail.js";
import { registerDriveTools } from "./src/drive.js";

/**
 * OpenClaw Google Workspace Plugin
 *
 * Provides Gmail and Google Drive access via Google APIs.
 * Requires OAuth2 credentials (user tokens) or service account JSON key.
 *
 * Tools registered:
 * - google_gmail: search_messages, get_message, list_threads, get_attachment,
 *                 send_message (write scope), modify_labels (write scope)
 * - google_drive: search_files, get_file, download_file, export_google_doc,
 *                 upload_file (write scope), create_folder (write scope), share_file (write scope)
 *
 * Default scopeProfile=read keeps operations read-only.
 * Write operations require scopeProfile=write and tool-level safety gates.
 * Phase 3 will add Gmail Pub/Sub event bridge for automation
 */
const plugin = {
  id: "google-workspace",
  name: "Google Workspace",
  description: "OpenClaw Google Workspace plugin (Gmail + Drive, with write actions gated by scope)",
  configSchema: emptyPluginConfigSchema(), // Config validation happens at runtime
  register(api: OpenClawPluginApi) {
    try {
      // Parse and validate config
      const userConfig = api.config as unknown;
      const config = GoogleWorkspaceConfigSchema.parse(userConfig);

      api.logger?.info?.(`google-workspace: Parsed config with scopeProfile=${config.scopeProfile}`);

      // Register Gmail tools
      registerGmailTools(api, config).catch((err) => {
        api.logger?.error?.(
          `google-workspace: Failed to register Gmail tools: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      // Register Drive tools
      registerDriveTools(api, config).catch((err) => {
        api.logger?.error?.(
          `google-workspace: Failed to register Drive tools: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      api.logger?.info?.("google-workspace: Plugin registered successfully");
    } catch (err) {
      api.logger?.error?.(
        `google-workspace: Plugin registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  },
};

export default plugin;
