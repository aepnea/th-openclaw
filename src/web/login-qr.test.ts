import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWebLoginWithQr, waitForWebLogin } from "./login-qr.js";
import {
  createWaSocket,
  logoutWeb,
  readWebSelfId,
  waitForWaConnection,
  webAuthExists,
} from "./session.js";

vi.mock("./session.js", () => {
  const createWaSocket = vi.fn(
    async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
      const sock = { ws: { close: vi.fn() } };
      if (opts?.onQr) {
        setImmediate(() => opts.onQr?.("qr-data"));
      }
      return sock;
    },
  );
  const waitForWaConnection = vi.fn();
  const formatError = vi.fn((err: unknown) => `formatted:${String(err)}`);
  const getStatusCode = vi.fn(
    (err: unknown) =>
      (err as { output?: { statusCode?: number } })?.output?.statusCode ??
      (err as { status?: number })?.status,
  );
  const webAuthExists = vi.fn(async () => false);
  const readWebSelfId = vi.fn(() => ({ e164: null, jid: null }));
  const logoutWeb = vi.fn(async () => true);
  return {
    createWaSocket,
    waitForWaConnection,
    formatError,
    getStatusCode,
    webAuthExists,
    readWebSelfId,
    logoutWeb,
  };
});

vi.mock("./qr-image.js", () => ({
  renderQrPngBase64: vi.fn(async () => "base64"),
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const logoutWebMock = vi.mocked(logoutWeb);
const webAuthExistsMock = vi.mocked(webAuthExists);
const readWebSelfIdMock = vi.mocked(readWebSelfId);

describe("login-qr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns plain ASCII already-linked message when force is not requested", async () => {
    webAuthExistsMock.mockResolvedValueOnce(true);
    readWebSelfIdMock.mockReturnValueOnce({ e164: "+56928304421", jid: null });

    const result = await startWebLoginWithQr({ timeoutMs: 5000 });

    expect(result.message).toContain('Say "relink" if you want a fresh QR.');
    expect(createWaSocketMock).not.toHaveBeenCalled();
    expect(logoutWebMock).not.toHaveBeenCalled();
  });

  it("clears cached auth on forced relink before creating a fresh QR session", async () => {
    webAuthExistsMock.mockResolvedValueOnce(true);

    const result = await startWebLoginWithQr({ timeoutMs: 5000, force: true });

    expect(result.qrDataUrl).toBe("data:image/png;base64,base64");
    expect(logoutWebMock).toHaveBeenCalledTimes(1);
    expect(createWaSocketMock).toHaveBeenCalledTimes(1);
  });

  it("restarts login once on status 515 and completes", async () => {
    waitForWaConnectionMock
      .mockRejectedValueOnce({ output: { statusCode: 515 } })
      .mockResolvedValueOnce(undefined);

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,base64");

    const result = await waitForWebLogin({ timeoutMs: 5000 });

    expect(result.connected).toBe(true);
    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    expect(logoutWebMock).not.toHaveBeenCalled();
  });
});
