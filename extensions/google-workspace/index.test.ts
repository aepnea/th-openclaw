import { describe, test, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import plugin from "./index.js";
import { GoogleWorkspaceConfigSchema } from "./src/config-schema.js";

describe("google-workspace plugin", () => {
  describe("plugin registration", () => {
    test("should define plugin with correct id and metadata", () => {
      expect(plugin.id).toBe("google-workspace");
      expect(plugin.name).toBe("Google Workspace");
      expect(plugin.description).toContain("Phase 1");
      expect(plugin.register).toBeDefined();
    });
  });

  describe("config schema validation", () => {
    test("should validate OAuth2 config", () => {
      const config = {
        auth: {
          type: "oauth2",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
        },
        scopeProfile: "read",
      };

      const parsed = GoogleWorkspaceConfigSchema.parse(config);
      expect(parsed.auth.type).toBe("oauth2");
      expect(parsed.scopeProfile).toBe("read");
    });

    test("should validate service account config", () => {
      const config = {
        auth: {
          type: "service_account",
          credentials: { type: "service_account", project_id: "test-project" },
        },
        scopeProfile: "read",
      };

      const parsed = GoogleWorkspaceConfigSchema.parse(config);
      expect(parsed.auth.type).toBe("service_account");
    });

    test("should apply default scopeProfile", () => {
      const config = {
        auth: {
          type: "oauth2",
          clientId: "test-id",
          clientSecret: "test-secret",
          accessToken: "test-token",
          refreshToken: "test-refresh",
        },
      };

      const parsed = GoogleWorkspaceConfigSchema.parse(config);
      expect(parsed.scopeProfile).toBe("read");
    });

    test("should apply default drive config", () => {
      const config = {
        auth: {
          type: "oauth2",
          clientId: "test-id",
          clientSecret: "test-secret",
          accessToken: "test-token",
          refreshToken: "test-refresh",
        },
      };

      const parsed = GoogleWorkspaceConfigSchema.parse(config);
      expect(parsed.drive.maxDownloadMb).toBe(20);
      expect(parsed.drive.allowedMimePrefixes).toContain("text/");
    });

    test("should apply default gmail config", () => {
      const config = {
        auth: {
          type: "oauth2",
          clientId: "test-id",
          clientSecret: "test-secret",
          accessToken: "test-token",
          refreshToken: "test-refresh",
        },
      };

      const parsed = GoogleWorkspaceConfigSchema.parse(config);
      expect(parsed.gmail.maxAttachmentMb).toBe(20);
      expect(Array.isArray(parsed.gmail.allowedRecipientDomains)).toBe(true);
    });

    test("should reject invalid config", () => {
      const config = {
        auth: {
          type: "invalid",
        },
      };

      expect(() => GoogleWorkspaceConfigSchema.parse(config)).toThrow();
    });

    test("should require auth in config", () => {
      const config = {
        scopeProfile: "read",
      };

      expect(() => GoogleWorkspaceConfigSchema.parse(config)).toThrow();
    });
  });

  describe("plugin register function", () => {
    let mockApi: Partial<OpenClawPluginApi>;

    beforeEach(() => {
      mockApi = {
        config: {
          auth: {
            type: "oauth2",
            clientId: "test-id",
            clientSecret: "test-secret",
            accessToken: "test-token",
            refreshToken: "test-refresh",
          },
          scopeProfile: "read",
        },
        registerTool: vi.fn(),
        logger: {
          info: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      };
    });

    test("should register tools on valid config", () => {
      plugin.register(mockApi as OpenClawPluginApi);

      expect(mockApi.logger?.info).toHaveBeenCalledWith(expect.stringContaining("Parsed config"));
      expect(mockApi.logger?.info).toHaveBeenCalledWith(
        expect.stringContaining("Plugin registered successfully"),
      );
    });

    test("should handle registration errors gracefully", () => {
      const invalidConfig = { auth: { type: "invalid" } };
      mockApi.config = invalidConfig;

      expect(() => plugin.register(mockApi as OpenClawPluginApi)).toThrow();
      expect(mockApi.logger?.error).toHaveBeenCalledWith(
        expect.stringContaining("Plugin registration failed"),
      );
    });
  });

  describe("log redaction (security)", () => {
    test("should not leak tokens in logs", () => {
      const config = {
        auth: {
          type: "oauth2",
          clientId: "test-id",
          clientSecret: "test-secret",
          accessToken: "SENSITIVE_TOKEN_12345",
          refreshToken: "SENSITIVE_REFRESH_TOKEN_67890",
        },
        scopeProfile: "read",
      };

      const mockApi: Partial<OpenClawPluginApi> = {
        config,
        registerTool: vi.fn(),
        logger: {
          info: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      };

      plugin.register(mockApi as OpenClawPluginApi);

      // Check that the raw tokens are not logged anywhere
      const allLogCalls = [
        ...(mockApi.logger?.info as any)?.mock?.calls || [],
        ...(mockApi.logger?.error as any)?.mock?.calls || [],
        ...(mockApi.logger?.debug as any)?.mock?.calls || [],
      ];

      const allLogText = allLogCalls.map((call) => JSON.stringify(call)).join(" ");
      expect(allLogText).not.toContain("SENSITIVE_TOKEN_12345");
      expect(allLogText).not.toContain("SENSITIVE_REFRESH_TOKEN_67890");
    });
  });
});
