/**
 * WhatsApp Reminder List Tool
 *
 * Allows a whitelisted user to see their own pending reminders.
 *
 * Privacy guarantees:
 * - Only returns reminders belonging to the sender_phone
 * - Never exposes other users' reminders
 *
 * Parameters:
 * - sender_phone: E.164 phone number (must be whitelisted)
 * - detected_language: "es" | "en" | "pt" (default "es")
 *
 * Returns:
 * - pending_count: number of pending reminders
 * - reminders: array of { id, reminder_text, scheduled_for, minutes_remaining }
 * - response_message: human-readable list for Igor to relay to the user
 * - error: error string if something went wrong
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import {
  listReminders,
  type Language,
} from "../../storage/reminder-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const log = createSubsystemLogger("whatsapp-reminder-list");

const WhatsAppReminderListSchema = Type.Object({
  sender_phone: Type.String({ minLength: 5, maxLength: 20 }),
  detected_language: Type.Optional(
    Type.Union([Type.Literal("es"), Type.Literal("en"), Type.Literal("pt")]),
  ),
});

export function createWhatsAppReminderListTool(opts?: {
  config?: OpenClawConfig;
  whitelistPhones?: string[];
}): AnyAgentTool {
  const whitelist: string[] = opts?.whitelistPhones ?? ["+56972101837", "+56998344300"];

  return {
    label: "WhatsApp Reminder List",
    name: "whatsapp_reminder_list",
    description:
      "List all pending reminders for the requesting user. Only shows reminders belonging to the sender_phone — completely private. Returns each reminder's text, scheduled time, and minutes remaining.",
    parameters: WhatsAppReminderListSchema,
    ownerOnly: false,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      try {
        const senderPhone = readStringParam(params, "sender_phone", { required: true });
        const lang = ((readStringParam(params, "detected_language") ?? "es") as Language);

        log.info(`Reminder list request from ${senderPhone}`);

        // ── Whitelist check ──────────────────────────────────────────────────
        if (!whitelist.includes(senderPhone)) {
          const msg =
            lang === "en"
              ? "You are not authorized to use reminders."
              : lang === "pt"
              ? "Você não está autorizado a usar lembretes."
              : "No estás autorizado para usar recordatorios.";
          return jsonResult({ success: false, error: "unauthorized", message: msg });
        }

        // ── Fetch pending reminders ──────────────────────────────────────────
        const reminders = await listReminders(senderPhone, { statusFilter: ["pending"] });
        const now = Date.now();

        const items = reminders
          .map((r) => {
            const msRemaining = Math.max(0, new Date(r.scheduled_for).getTime() - now);
            const minutesRemaining = Math.ceil(msRemaining / 60000);
            return {
              id: r.id,
              reminder_text: r.reminder_text,
              scheduled_for: r.scheduled_for,
              minutes_remaining: minutesRemaining,
            };
          })
          .sort((a, b) => a.minutes_remaining - b.minutes_remaining);

        // ── Build human-readable response ────────────────────────────────────
        let responseMessage: string;
        if (items.length === 0) {
          responseMessage =
            lang === "en"
              ? "You have no pending reminders."
              : lang === "pt"
              ? "Você não tem lembretes pendentes."
              : "No tienes recordatorios pendientes.";
        } else {
          const header =
            lang === "en"
              ? `📋 *Your pending reminders* (${items.length}):\n`
              : lang === "pt"
              ? `📋 *Seus lembretes pendentes* (${items.length}):\n`
              : `📋 *Tus recordatorios pendientes* (${items.length}):\n`;

          const lines = items.map((item, i) => {
            const timeLabel =
              item.minutes_remaining < 60
                ? lang === "en"
                  ? `in ${item.minutes_remaining} min`
                  : lang === "pt"
                  ? `em ${item.minutes_remaining} min`
                  : `en ${item.minutes_remaining} min`
                : (() => {
                    const h = Math.floor(item.minutes_remaining / 60);
                    const m = item.minutes_remaining % 60;
                    return m > 0 ? `${h}h ${m}min` : `${h}h`;
                  })();
            return `${i + 1}. _${item.reminder_text}_ — ${timeLabel}`;
          });

          responseMessage = header + lines.join("\n");
        }

        return jsonResult({
          success: true,
          pending_count: items.length,
          reminders: items,
          response_message: responseMessage,
        });
      } catch (err) {
        log.error(`Reminder list error: ${String(err)}`);
        return jsonResult({
          success: false,
          error: "system_error",
          message: String(err),
        });
      }
    },
  };
}
