import { describe, test, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerDriveTools } from "./drive.js";
import type { GoogleWorkspaceConfig } from "./config-schema.js";

const mockFilesList = vi.fn();
const mockFilesGet = vi.fn();
const mockFilesCreate = vi.fn();
const mockPermissionsCreate = vi.fn();

const mockDriveService = {
  files: {
    list: mockFilesList,
    get: mockFilesGet,
    create: mockFilesCreate,
  },
  permissions: {
    create: mockPermissionsCreate,
  },
};

// Mock googleapis
vi.mock("googleapis", () => ({
  drive_v3: {
    Drive: vi.fn(() => mockDriveService),
  },
}));

vi.mock("./auth.js", () => ({
  createGoogleAuthClient: vi.fn().mockResolvedValue({}),
}));

describe("Drive tools", () => {
  let mockApi: Partial<OpenClawPluginApi>;
  let registerToolFn: any;

  beforeEach(() => {
    registerToolFn = vi.fn();
    mockFilesList.mockReset();
    mockFilesGet.mockReset();
    mockFilesCreate.mockReset();
    mockPermissionsCreate.mockReset();
    mockApi = {
      registerTool: registerToolFn,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  });

  test("should register drive tool", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "read",
      drive: { maxDownloadMb: 20, allowedMimePrefixes: ["text/", "application/pdf"] },
    };

    await registerDriveTools(mockApi as OpenClawPluginApi, config);

    expect(registerToolFn).toHaveBeenCalled();
    const toolDef = registerToolFn.mock.calls[0][0];

    expect(toolDef.name).toBe("google_drive");
    expect(toolDef.label).toBe("Google Drive");
    expect(toolDef.description).toContain("search_files");
    expect(toolDef.execute).toBeDefined();
  });

  test("should handle search_files action", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "read",
    };

    await registerDriveTools(mockApi as OpenClawPluginApi, config);

    const toolDef = registerToolFn.mock.calls[0][0];

    mockFilesList.mockResolvedValue({
      data: {
        files: [{ id: "file-1", name: "report.pdf" }],
      },
    });

    const result = await toolDef.execute("tool-call-1", {
      action: "search_files",
      query: "name contains 'report'",
    });

    expect(result.details.files).toHaveLength(1);
    expect(result.details.files[0].id).toBe("file-1");
    expect(mockFilesList).toHaveBeenCalled();
  });

  test("should respect MIME type allowlist in download", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "read",
      drive: { maxDownloadMb: 20, allowedMimePrefixes: ["text/", "application/pdf"] },
    };

    await registerDriveTools(mockApi as OpenClawPluginApi, config);
    expect(registerToolFn).toHaveBeenCalled();
  });

  test("should block upload_file when scopeProfile is read", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "read",
    };

    await registerDriveTools(mockApi as OpenClawPluginApi, config);
    const toolDef = registerToolFn.mock.calls[0][0];

    const result = await toolDef.execute("tool-call-2", {
      action: "upload_file",
      name: "a.txt",
      mimeType: "text/plain",
      contentBase64: "SGVsbG8=",
    });

    expect(result.details.error).toContain("scopeProfile=write");
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });

  test("should upload_file when scopeProfile is write", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "write",
      drive: { maxDownloadMb: 20, allowedMimePrefixes: ["text/"] },
    };

    mockFilesCreate.mockResolvedValue({
      data: {
        id: "uploaded-1",
        name: "a.txt",
        mimeType: "text/plain",
        size: "5",
      },
    });

    await registerDriveTools(mockApi as OpenClawPluginApi, config);
    const toolDef = registerToolFn.mock.calls[0][0];

    const result = await toolDef.execute("tool-call-3", {
      action: "upload_file",
      name: "a.txt",
      mimeType: "text/plain",
      contentBase64: "SGVsbG8=",
    });

    expect(result.details.uploaded).toBe(true);
    expect(result.details.id).toBe("uploaded-1");
    expect(mockFilesCreate).toHaveBeenCalled();
  });

  test("should create_folder when scopeProfile is write", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "write",
    };

    mockFilesCreate.mockResolvedValue({
      data: {
        id: "folder-1",
        name: "New Folder",
        mimeType: "application/vnd.google-apps.folder",
      },
    });

    await registerDriveTools(mockApi as OpenClawPluginApi, config);
    const toolDef = registerToolFn.mock.calls[0][0];

    const result = await toolDef.execute("tool-call-4", {
      action: "create_folder",
      name: "New Folder",
    });

    expect(result.details.created).toBe(true);
    expect(result.details.id).toBe("folder-1");
  });

  test("should enforce share domain allowlist", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "write",
      drive: {
        maxDownloadMb: 20,
        allowedMimePrefixes: ["text/"],
        allowedShareDomains: ["company.com"],
      },
    };

    await registerDriveTools(mockApi as OpenClawPluginApi, config);
    const toolDef = registerToolFn.mock.calls[0][0];

    const result = await toolDef.execute("tool-call-5", {
      action: "share_file",
      fileId: "file-1",
      type: "user",
      role: "reader",
      emailAddress: "alice@external.com",
    });

    expect(result.details.error).toContain("Share denied by policy");
    expect(mockPermissionsCreate).not.toHaveBeenCalled();
  });

  test("should share file for allowed domain", async () => {
    const config: GoogleWorkspaceConfig = {
      auth: {
        type: "oauth2",
        clientId: "test-id",
        clientSecret: "test-secret",
        accessToken: "test-token",
        refreshToken: "test-refresh",
      },
      scopeProfile: "write",
      drive: {
        maxDownloadMb: 20,
        allowedMimePrefixes: ["text/"],
        allowedShareDomains: ["company.com"],
      },
    };

    mockPermissionsCreate.mockResolvedValue({
      data: {
        id: "perm-1",
        type: "user",
        role: "reader",
        emailAddress: "alice@company.com",
      },
    });

    await registerDriveTools(mockApi as OpenClawPluginApi, config);
    const toolDef = registerToolFn.mock.calls[0][0];

    const result = await toolDef.execute("tool-call-6", {
      action: "share_file",
      fileId: "file-1",
      type: "user",
      role: "reader",
      emailAddress: "alice@company.com",
    });

    expect(result.details.shared).toBe(true);
    expect(result.details.permission.id).toBe("perm-1");
    expect(mockPermissionsCreate).toHaveBeenCalled();
  });
});
