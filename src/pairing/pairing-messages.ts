import type { PairingChannel } from "./pairing-store.js";

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
}): string {
  const { code } = params;
  return [
    "🤖 Cephus Agent",
    "",
    "Necesitas autorización para usar este agente.",
    "You need authorization to use this agent.",
    "",
    `Código / Code: ${code}`,
  ].join("\n");
}
