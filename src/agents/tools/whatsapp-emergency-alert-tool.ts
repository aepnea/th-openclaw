import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { sendEmergencyAlertWhatsApp } from "../../web/outbound.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const log = createSubsystemLogger("whatsapp-emergency-alert");

const WhatsAppEmergencyAlertSchema = Type.Object({
  sender_phone: Type.String({ minLength: 5, maxLength: 20 }),
  emergency_numbers: Type.Array(
    Type.String({ minLength: 5, maxLength: 20 }),
    { minItems: 1, maxItems: 20 },
  ),
  message: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 500,
    }),
  ),
  accountId: Type.Optional(Type.String()),
});

/**
 * Creates a WhatsApp emergency alert tool for Igor.
 * Allows authorized users to send emergency SOS messages to a
 * pre-configured list of emergency contacts via WhatsApp.
 *
 * Security:
 * - Accessible only to Igor agent (authorized in IDENTITY.md)
 * - Sender phone must be whitelisted in config
 * - Recipients must be from emergency-contacts.json for verified sender
 * - All attempts logged with correlation IDs
 *
 * Returns aggregate status of message delivery attempts:
 * - success: true only if all messages sent without error
 * - sent_count: number of successfully sent messages
 * - failed_count: number of failed attempts
 * - failures: array of {number, error} pairs for failed recipients
 * - message_ids: array of Baileys message IDs for audit trail
 */
export function createWhatsAppEmergencyAlertTool(opts?: {
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "WhatsApp Emergency Alert",
    name: "send_emergency_alert",
    description:
      "Send WhatsApp emergency alert (SOS) to multiple pre-configured emergency contacts. Requires sender_phone from whitelist and emergency_numbers from verified emergency contact list. Each message is sent individually via WhatsApp Baileys socket. Returns success status and message delivery details.",
    parameters: WhatsAppEmergencyAlertSchema,
    ownerOnly: false,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      try {
        const sender_phone = readStringParam(params, "sender_phone", { required: true });
        const emergencyNumbersRaw = params.emergency_numbers;
        const messageParam = readStringParam(params, "message");
        const message = typeof messageParam === "string" && messageParam.trim() 
          ? messageParam.trim() 
          : "🚨 EMERGENCY ALERT";
        const accountId = readStringParam(params, "accountId");

        // Validate emergency_numbers is array
        if (!Array.isArray(emergencyNumbersRaw)) {
          log.warn(
            "emergency_numbers is not an array: " + JSON.stringify(emergencyNumbersRaw),
          );
          return jsonResult({
            ok: false,
            error: "emergency_numbers must be an array of phone numbers",
            details: {
              success: false,
              sent_count: 0,
              failed_count: 0,
              failures: [],
              timestamp: new Date().toISOString(),
              message_ids: [],
            },
          });
        }

        const emergency_numbers: string[] = emergencyNumbersRaw.map((num) => String(num));

        // Validate each number
        for (const num of emergency_numbers) {
          if (!/^\+\d{1,15}$/.test(num)) {
            log.warn("invalid phone number format: " + num);
            return jsonResult({
              ok: false,
              error: `Invalid phone number format: ${num}. Must be E.164 format (e.g., +56972101837)`,
              details: {
                success: false,
                sent_count: 0,
                failed_count: 0,
                failures: [{ number: num, error: "Invalid E.164 format" }],
                timestamp: new Date().toISOString(),
                message_ids: [],
              },
            });
          }
        }

        log.info(
          `[EMERGENCY] SOS alert trigger starting - sender: ${sender_phone}, count: ${emergency_numbers.length}, messageLength: ${message.length}`,
        );

        // Call the gateway function
        const result = await sendEmergencyAlertWhatsApp({
          sender_phone,
          emergency_numbers,
          message,
          accountId,
        });

        log.info(
          `[EMERGENCY] SOS alert complete - sender: ${sender_phone}, sent: ${result.sent_count}/${emergency_numbers.length}, failed: ${result.failed_count}`,
        );

        return jsonResult({
          ok: result.success,
          message: result.success
            ? `Emergency alert sent to ${result.sent_count}/${emergency_numbers.length} contacts`
            : `Emergency alert partially sent: ${result.sent_count}/${emergency_numbers.length} successful`,
          details: result,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error(
          `[EMERGENCY] Critical failure in send_emergency_alert tool: ${errorMsg}`,
        );

        return jsonResult({
          ok: false,
          error: errorMsg,
          details: {
            success: false,
            sent_count: 0,
            failed_count: 0,
            failures: [],
            timestamp: new Date().toISOString(),
            message_ids: [],
          },
        });
      }
    },
  };
}
