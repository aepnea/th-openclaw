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

const log = createSubsystemLogger("whatsapp-blacklist-add");

const WhatsAppBlacklistAddSchema = Type.Object({
  sender_phone: Type.String({ minLength: 5, maxLength: 20 }),
  phone_to_block: Type.String({ minLength: 5, maxLength: 20 }),
  reason: Type.String({ minLength: 1, maxLength: 200 }),
  detected_language: Type.Optional(
    Type.Union([Type.Literal("es"), Type.Literal("en"), Type.Literal("pt")])
  ),
  accountId: Type.Optional(Type.String()),
});

/**
 * Creates a WhatsApp blacklist add tool for Igor
 * Allows whitelisted users to add phone numbers to the shared blacklist
 *
 * Security:
 * - Accessible only through Igor agent
 * - Sender phone must be whitelisted
 * - All attempts logged with correlation IDs
 * - No deletions allowed (permanent records)
 *
 * Parameters:
 * - sender_phone: Whitelisted phone number making the request
 * - phone_to_block: Phone number to be blacklisted (E.164 format)
 * - reason: Explanation for blacklisting (1-200 characters)
 * - detected_language: Conversation language (es/en/pt, default: es)
 *
 * Returns:
 * - success: boolean indicating if number was added
 * - id: UUID of the blacklist entry
 * - blocked_phone: The phone number added
 * - reason: The provided reason
 * - timestamp: When it was added
 * - error: Error message if failed
 */
export function createWhatsAppBlacklistAddTool(opts?: {
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
    label: "WhatsApp Blacklist Add",
    name: "whatsapp_blacklist_add",
    description:
      "Add a phone number to the shared blacklist. Whitelisted users can report numbers displaying inappropriate behavior. The entry is permanent and includes the reason for blocking. Language of all messages matches the conversation language (Spanish/English/Portuguese).",
    parameters: WhatsAppBlacklistAddSchema,
    ownerOnly: false,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const correlationId = `blacklist-add-${Date.now()}`;

      try {
        const sender_phone = readStringParam(params, "sender_phone", { required: true });
        const phone_to_block = readStringParam(params, "phone_to_block", { required: true });
        const reason = readStringParam(params, "reason", { required: true });
        const detectedLang = (readStringParam(params, "detected_language") || "es") as Language;
        const accountId = readStringParam(params, "accountId");

        log.info(
          `[${correlationId}] Blacklist add request - sender: ${sender_phone}, target: ${phone_to_block}`
        );

        // Use detected language or default
        const language: Language = LanguageDetector.isValid(detectedLang) ? detectedLang : "es";
        log.info(`[${correlationId}] Using language: ${language}`);

        // Attempt to add to blacklist
        const result = await service.addToBlacklist(phone_to_block, reason, sender_phone);

        if (result.success) {
          log.info(
            `[${correlationId}] Successfully added to blacklist - id: ${result.id}, phone: ${phone_to_block}`
          );

          const successMessage = getBlacklistMessage("addSuccess", language, {
            phone: phone_to_block,
          });

          return jsonResult({
            ok: true,
            message: successMessage,
            details: {
              success: true,
              id: result.id,
              blocked_phone: result.blocked_phone,
              reason: result.reason,
              timestamp: result.timestamp,
            },
          });
        } else {
          // Handle validation errors
          let errorMessage: string;

          switch (result.errorCode) {
            case "INVALID_FORMAT":
              errorMessage = getBlacklistMessage("errorInvalidFormat", language);
              break;
            case "ALREADY_BLACKLISTED":
              errorMessage = getBlacklistMessage("errorAlreadyBlacklisted", language);
              break;
            case "INVALID_REASON":
              errorMessage = getBlacklistMessage("errorInvalidReason", language);
              break;
            case "SYSTEM_ERROR":
              errorMessage = getBlacklistMessage("errorSystem", language);
              break;
            default:
              errorMessage = result.error || getBlacklistMessage("errorSystem", language);
          }

          log.warn(
            `[${correlationId}] Blacklist add failed - code: ${result.errorCode}, error: ${result.error}`
          );

          return jsonResult({
            ok: false,
            message: errorMessage,
            details: {
              success: false,
              error: result.error,
              errorCode: result.errorCode,
            },
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error(`[${correlationId}] Critical failure in blacklist add: ${errorMsg}`);

        const errorMessage = getBlacklistMessage("errorSystem", "es");
        return jsonResult({
          ok: false,
          message: errorMessage,
          details: {
            success: false,
            error: errorMsg,
            errorCode: "SYSTEM_ERROR",
          },
        });
      }
    },
  };
}
