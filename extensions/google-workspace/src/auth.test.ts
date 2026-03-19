import { describe, test, expect, vi, beforeEach } from "vitest";
import * as authLib from "google-auth-library";
import { createGoogleAuthClient, getAccessToken, revokeToken } from "./auth.js";
import type { GoogleWorkspaceConfig } from "./config-schema.js";

// Mock google-auth-library
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(),
  GoogleAuth: vi.fn(),
}));

describe("auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createGoogleAuthClient (OAuth2)", () => {
    test("should create OAuth2Client with user credentials", async () => {
      const mockClient = {
        setCredentials: vi.fn(),
      };

      (authLib.OAuth2Client as any).mockImplementation(() => mockClient);

      const config: GoogleWorkspaceConfig = {
        auth: {
          type: "oauth2",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
          expiryDate: Date.now() + 3600000,
        },
        scopeProfile: "read",
      };

      const client = await createGoogleAuthClient(config);

      expect(authLib.OAuth2Client).toHaveBeenCalledWith({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });

      expect(mockClient.setCredentials).toHaveBeenCalledWith({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expiry_date: expect.any(Number),
      });

      expect(client).toBe(mockClient);
    });

    test("should include write scopes when scopeProfile is write", async () => {
      const mockAuth = {
        getClient: vi.fn(),
      };

      (authLib.GoogleAuth as any).mockImplementation((opts) => {
        // Verify write scopes were passed
        expect(opts.scopes).toContain("https://www.googleapis.com/auth/gmail.send");
        expect(opts.scopes).toContain("https://www.googleapis.com/auth/drive");
        return mockAuth;
      });

      const mockClient = {};
      mockAuth.getClient.mockResolvedValue(mockClient);

      const config: GoogleWorkspaceConfig = {
        auth: {
          type: "service_account",
          credentials: { type: "service_account", project_id: "test" },
        },
        scopeProfile: "write",
      };

      await createGoogleAuthClient(config);

      expect(authLib.GoogleAuth).toHaveBeenCalled();
    });
  });

  describe("getAccessToken", () => {
    test("should get and format access token correctly", async () => {
      const mockClient = {
        setCredentials: vi.fn(),
        getAccessToken: vi.fn().mockResolvedValue({ token: "new-access-token" }),
      };

      (authLib.OAuth2Client as any).mockImplementation(() => mockClient);

      const config: GoogleWorkspaceConfig = {
        auth: {
          type: "oauth2",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
        },
        scopeProfile: "read",
      };

      const token = await getAccessToken(config);

      expect(token).toBe("new-access-token");
      expect(mockClient.getAccessToken).toHaveBeenCalled();
    });

    test("should throw when token is missing", async () => {
      const mockClient = {
        setCredentials: vi.fn(),
        getAccessToken: vi.fn().mockResolvedValue({ token: null }),
      };

      (authLib.OAuth2Client as any).mockImplementation(() => mockClient);

      const config: GoogleWorkspaceConfig = {
        auth: {
          type: "oauth2",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
        },
        scopeProfile: "read",
      };

      await expect(getAccessToken(config)).rejects.toThrow("Failed to obtain Google Workspace access token");
    });
  });

  describe("revokeToken", () => {
    test("should revoke token for OAuth2", async () => {
      const mockClient = {
        setCredentials: vi.fn(),
        getAccessToken: vi.fn().mockResolvedValue({ token: "test-token" }),
        revokeToken: vi.fn().mockResolvedValue(undefined),
      };

      (authLib.OAuth2Client as any).mockImplementation(() => mockClient);

      const config: GoogleWorkspaceConfig = {
        auth: {
          type: "oauth2",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
        },
        scopeProfile: "read",
      };

      await revokeToken(config);

      expect(mockClient.revokeToken).toHaveBeenCalledWith("test-token");
    });

    test("should not revoke for service account", async () => {
      const config: GoogleWorkspaceConfig = {
        auth: {
          type: "service_account",
          credentials: { type: "service_account" },
        },
        scopeProfile: "read",
      };

      // Should return early without error
      await expect(revokeToken(config)).resolves.toBeUndefined();
    });
  });
});
