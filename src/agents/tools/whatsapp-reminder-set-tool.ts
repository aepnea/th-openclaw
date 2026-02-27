/**
 * WhatsApp Reminder Set Tool
 *
 * Allows a whitelisted user to schedule a personal reminder that Igor will
 * send back to them after a specified number of minutes.
 *
 * Privacy guarantees:
 * - Only the requesting sender receives their reminder
 * - All storage is scoped to the sender's phone number
 * - Reminders are never visible to or shared with other whitelisted users
 *
 * Security:
 * - sender_phone must be in the whitelist
 * - delay_minutes is capped at 10 080 (1 week)
 * - All reminder activity is logged with correlation IDs
 *
 * Parameters:
 * - sender_phone: E.164 phone number (must be whitelisted)
 * - delay_minutes: how many minutes from now (1–10080)
 * - reminder_text: what the reminder is about (1–200 chars)
 * - detected_language: "es" | "en" | "pt" (default "es")
 * - accountId: optional WhatsApp account id
 *
 * Returns:
 * - success: boolean
 * - reminder_id: UUID of the created reminder
 * - scheduled_for: ISO string of when it will fire
 * - confirmation_message: human-readable confirmation in the detected language
 *   (Igor should relay this to the user verbatim)
 * - error: error string if something went wrong
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { saveReminder, type Language } from "../../storage/reminder-storage.js";
import { reminderScheduler } from "../../scheduler/reminder-scheduler.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const log = createSubsystemLogger("whatsapp-reminder-set");

// ─── Schema ───────────────────────────────────────────────────────────────────

const WhatsAppReminderSetSchema = Type.Object({
  sender_phone: Type.String({ minLength: 5, maxLength: 20 }),
  delay_minutes: Type.Integer({ minimum: 1, maximum: 10080 }),
  reminder_text: Type.String({ minLength: 1, maxLength: 200 }),
  detected_language: Type.Optional(
    Type.Union([Type.Literal("es"), Type.Literal("en"), Type.Literal("pt")]),
  ),
  accountId: Type.Optional(Type.String()),
});

// ─── i18n helpers ─────────────────────────────────────────────────────────────

function formatSendMessage(reminderText: string, lang: Language): string {
  switch (lang) {
    case "en":
      return `⏰ *Reminder*\n${reminderText}`;
    case "pt":
      return `⏰ *Lembrete*\n${reminderText}`;
    default: // "es"
      return `⏰ *Recordatorio*\n${reminderText}`;
  }
}

function formatConfirmation(params: {
  reminderText: string;
  delayMinutes: number;
  scheduledFor: Date;
  lang: Language;
}): string {
  const { reminderText, delayMinutes, scheduledFor, lang } = params;
  const hhmm = scheduledFor.toLocaleTimeString("es-CL", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const delayStr = (() => {
    if (delayMinutes < 60) return `${delayMinutes} min`;
    const h = Math.floor(delayMinutes / 60);
    const m = delayMinutes % 60;
    if (m === 0) return lang === "es" ? `${h} hora${h > 1 ? "s" : ""}` : `${h} hour${h > 1 ? "s" : ""}`;
    return lang === "es"
      ? `${h}h ${m}min`
      : lang === "pt"
      ? `${h}h ${m}min`
      : `${h}h ${m}min`;
  })();

  switch (lang) {
    case "en":
      return `✅ Reminder set. I'll send you a reminder in ${delayStr} (at ${hhmm}).\n📝 _${reminderText}_`;
    case "pt":
      return `✅ Lembrete salvo. Vou te avisar em ${delayStr} (às ${hhmm}).\n📝 _${reminderText}_`;
    default: // "es"
      return `✅ Recordatorio guardado. Te aviso en ${delayStr} (a las ${hhmm}).\n📝 _${reminderText}_`;
  }
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createWhatsAppReminderSetTool(opts?: {
  config?: OpenClawConfig;
  whitelistPhones?: string[];
}): AnyAgentTool {
  const whitelist: string[] = opts?.whitelistPhones ?? ["+56972101837", "+56998344300"];

  return {
    label: "WhatsApp Reminder Set",
    name: "whatsapp_reminder_set",
    description:
      "Schedule a personal WhatsApp reminder for a whitelisted user. Igor will send the reminder message back to the user's phone after the specified number of minutes. Reminders are private — no other user can see or access them. Maximum delay is 10080 minutes (1 week).",
    parameters: WhatsAppReminderSetSchema,
    ownerOnly: false,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const correlationId = `reminder-set-${Date.now()}`;

      try {
        const senderPhone = readStringParam(params, "sender_phone", { required: true });
        const delayMinutes = Number(params["delay_minutes"]);
        const reminderText = readStringParam(params, "reminder_text", { required: true });
        const lang = ((readStringParam(params, "detected_language") ?? "es") as Language);
        const accountId = readStringParam(params, "accountId");

        log.info(
          `[${correlationId}] Reminder set request from ${senderPhone} | delay=${delayMinutes}min | text="${reminderText.slice(0, 50)}"`
        );

        // ── Whitelist check ──────────────────────────────────────────────────
        if (!whitelist.includes(senderPhone)) {
          log.warn(`[${correlationId}] Rejected — ${senderPhone} not in whitelist`);
          const msg =
            lang === "en"
              ? "You are not authorized to use reminders."
              : lang === "pt"
              ? "Você não está autorizado a usar lembretes."
              : "No estás autorizado para usar recordatorios.";
          return jsonResult({ success: false, error: "unauthorized", message: msg });
        }

        // ── Validate delay ───────────────────────────────────────────────────
        if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 10080) {
          const msg =
            lang === "en"
              ? "Delay must be between 1 and 10080 minutes (1 week)."
              : lang === "pt"
              ? "O atraso deve ser entre 1 e 10080 minutos (1 semana)."
              : "El tiempo debe estar entre 1 y 10080 minutos (1 semana).";
          return jsonResult({ success: false, error: "invalid_delay", message: msg });
        }

        // ── Compute scheduled_for ────────────────────────────────────────────
        const scheduledFor = new Date(Date.now() + delayMinutes * 60 * 1000);

        // ── Build messages ───────────────────────────────────────────────────
        const formattedSendMessage = formatSendMessage(reminderText, lang);
        const confirmationMessage = formatConfirmation({
          reminderText,
          delayMinutes,
          scheduledFor,
          lang,
        });

        // ── Save to storage ──────────────────────────────────────────────────
        const reminder = await saveReminder({
          phone: senderPhone,
          reminder_text: reminderText,
          language: lang,
          formatted_send_message: formattedSendMessage,
          scheduled_for: scheduledFor,
          account_id: accountId ?? undefined,
        });

        // ── Register with scheduler ──────────────────────────────────────────
        reminderScheduler.scheduleReminder(reminder);

        log.info(
          `[${correlationId}] Reminder ${reminder.id} created → fires at ${scheduledFor.toISOString()}`
        );

        return jsonResult({
          success: true,
          reminder_id: reminder.id,
          scheduled_for: scheduledFor.toISOString(),
          delay_minutes: delayMinutes,
          confirmation_message: confirmationMessage,
        });
      } catch (err) {
        log.error(`[${correlationId}] Unexpected error: ${String(err)}`);
        return jsonResult({
          success: false,
          error: "system_error",
          message: String(err),
        });
      }
    },
  };
}
