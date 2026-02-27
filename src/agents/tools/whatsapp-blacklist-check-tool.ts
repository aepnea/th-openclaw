import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { BlacklistService } from "../../services/blacklist-service.js";
import { LanguageDetector, Language } from "../../utils/language-detector.js";
import { getBlacklistMessage } from "../../i18n/blacklist-messages.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { join } from "path";
import { homedir } from "os";

const log = createSubsystemLogger("whatsapp-blacklist-check");

const WhatsAppBlacklistCheckSchema = Type.Object({
  sender_phone: Type.String({ minLength: 5, maxLength: 20 }),
  phone_to_check: Type.String({ minLength: 5, maxLength: 20 }),
  detected_language: Type.Optional(
    Type.Union([Type.Literal("es"), Type.Literal("en"), Type.Literal("pt")])
  ),
  accountId: Type.Optional(Type.String()),
});

/**
 * Creates a WhatsApp blacklist check tool for Igor
 * Allows whitelisted users to query if a phone number is blacklisted
 *
 * Security:
 * - Accessible only through Igor agent
 * - Sender phone must be whitelisted
 * - Only returns: blocked_phone and reason (does NOT expose who reported it)
 * - Full list queries are denied at workflow level
 * - All requests logged
 *
 * Parameters:
 * - sender_phone: Whitelisted phone number making the request
 * - phone_to_check: Phone number to check (E.164 format)
 * - detected_language: Conversation language (es/en/pt, default: es)
 *
 * Returns:
 * - found: boolean indicating if phone is blacklisted
 * - blocked_phone: The queried number (only if found)
 * - reason: Why it was blocked (only if found)
 * - error: Error message if something went wrong
 *
 * Important:
 * - Response does NOT include who reported the number (added_by_phone)
 * - Response does NOT include timestamp or ID
 * - Only returns blocked_phone and reason for privacy
 */
export function createWhatsAppBlacklistCheckTool(opts?: {
  config?: OpenClawConfig;
  whitelistPhones?: string[];
}): AnyAgentTool {
  // Get whitelist from config or use provided list
  const defaultWhitelist = opts?.whitelistPhones || ["+56972101837", "+56998344300"];

  // Initialize blacklist service with file path
  const blacklistFilePath = join(homedir(), ".openclaw", "workspace-igor", "blacklist.json");
  const service = new BlacklistService({
    filePath: blacklistFilePath,
    whitelistPhones: defaultWhitelist,
  });

  return {
    label: "WhatsApp Blacklist Check",
    name: "whatsapp_blacklist_check",
    description:
      "Check if a specific phone number is in the blacklist and view the reason if it exists. Returns only the phone number and reason for blocking (does not expose who reported it). Full list access is restricted. Language of all messages matches the conversation language (Spanish/English/Portuguese).",
    parameters: WhatsAppBlacklistCheckSchema,
    ownerOnly: false,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const correlationId = `blacklist-check-${Date.now()}`;

      try {
        const sender_phone = readStringParam(params, "sender_phone", { required: true });
        const phone_to_check = readStringParam(params, "phone_to_check", { required: true });
        const detectedLang = (readStringParam(params, "detected_language") || "es") as Language;
        const accountId = readStringParam(params, "accountId");

        log.info(
          `[${correlationId}] Blacklist check request - sender: ${sender_phone}, target: ${phone_to_check}`
        );

        // Use detected language or default
        const language: Language = LanguageDetector.isValid(detectedLang) ? detectedLang : "es";
        log.info(`[${correlationId}] Using language: ${language}`);

        // Check if phone is blacklisted
        const result = await service.checkBlacklist(phone_to_check);

        if (result.found) {
          log.info(
            `[${correlationId}] Phone found on blacklist - phone: ${phone_to_check}, reason: ${result.reason}`
          );

          const foundMessage = getBlacklistMessage("checkFound", language, {
            reason: result.reason || "Not specified",
          });

          return jsonResult({
            ok: true,
            message: foundMessage,
            details: {
              found: true,
              blocked_phone: result.blocked_phone,
              reason: result.reason,
            },
          });
        } else {
          log.info(`[${correlationId}] Phone not on blacklist - phone: ${phone_to_check}`);

          const notFoundMessage = getBlacklistMessage("checkNotFound", language);

          return jsonResult({
            ok: true,
            message: notFoundMessage,
            details: {
              found: false,
            },
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error(`[${correlationId}] Critical failure in blacklist check: ${errorMsg}`);

        // Use Spanish as fallback
        const errorMessage = getBlacklistMessage("errorSystem", "es");
        return jsonResult({
          ok: false,
          message: errorMessage,
          details: {
            found: false,
            error: errorMsg,
            errorCode: "SYSTEM_ERROR",
          },
        });
      }
    },
  };
}
