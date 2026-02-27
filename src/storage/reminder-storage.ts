/**
 * Reminder Storage
 *
 * Stores reminders per-user in individual private JSON files.
 * Each whitelisted user has their own file - reminders are never
 * shared between users.
 *
 * Storage path: ~/.openclaw/workspace-igor/reminders/{phoneNormalized}.json
 *
 * File structure:
 * {
 *   version: "1.0",
 *   phone: "+56912345678",
 *   reminders: [ { id, phone, reminder_text, language, scheduled_for,
 *                  formatted_send_message, created_at, status, account_id? } ]
 * }
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("reminder-storage");

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReminderStatus = "pending" | "sent" | "failed" | "cancelled";
export type Language = "es" | "en" | "pt";

export interface Reminder {
  id: string;
  phone: string;           // E.164 owner of this reminder (always the requester)
  reminder_text: string;   // raw user-provided reminder description
  language: Language;      // detected language at creation time
  formatted_send_message: string; // full message to send when reminder fires
  scheduled_for: string;   // ISO 8601 — when to fire
  created_at: string;      // ISO 8601
  status: ReminderStatus;
  account_id?: string;     // WhatsApp accountId for sending
}

interface ReminderFile {
  version: "1.0";
  phone: string;
  reminders: Reminder[];
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

export function getRemindersDir(): string {
  return join(homedir(), ".openclaw", "workspace-igor", "reminders");
}

/** Produce a safe filename from a phone number, e.g. "+56972101837" → "56972101837.json" */
export function phoneToFilename(phone: string): string {
  return phone.replace(/[^0-9]/g, "") + ".json";
}

export function getRemindersFilePath(phone: string): string {
  return join(getRemindersDir(), phoneToFilename(phone));
}

// ─── Initialization ──────────────────────────────────────────────────────────

export async function ensureRemindersDirExists(): Promise<void> {
  const dir = getRemindersDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    log.info(`Created reminders directory: ${dir}`);
  }
}

async function initReminderFile(phone: string): Promise<void> {
  const filePath = getRemindersFilePath(phone);
  if (!existsSync(filePath)) {
    const initial: ReminderFile = { version: "1.0", phone, reminders: [] };
    await writeFile(filePath, JSON.stringify(initial, null, 2), "utf8");
  }
}

// ─── Read / Write helpers ────────────────────────────────────────────────────

async function readReminderFile(phone: string): Promise<ReminderFile> {
  await ensureRemindersDirExists();
  const filePath = getRemindersFilePath(phone);
  if (!existsSync(filePath)) {
    return { version: "1.0", phone, reminders: [] };
  }
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as ReminderFile;
}

async function writeReminderFile(data: ReminderFile): Promise<void> {
  await ensureRemindersDirExists();
  await initReminderFile(data.phone); // ensure file exists
  const filePath = getRemindersFilePath(data.phone);
  // Atomic write via tmp file
  const tmpPath = filePath + ".tmp." + Date.now();
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, filePath);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Save a new reminder for a phone number.
 * Returns the created Reminder.
 */
export async function saveReminder(params: {
  phone: string;
  reminder_text: string;
  language: Language;
  formatted_send_message: string;
  scheduled_for: Date;
  account_id?: string;
}): Promise<Reminder> {
  const fileData = await readReminderFile(params.phone);

  const reminder: Reminder = {
    id: randomUUID(),
    phone: params.phone,
    reminder_text: params.reminder_text,
    language: params.language,
    formatted_send_message: params.formatted_send_message,
    scheduled_for: params.scheduled_for.toISOString(),
    created_at: new Date().toISOString(),
    status: "pending",
    account_id: params.account_id,
  };

  fileData.reminders.push(reminder);
  await writeReminderFile(fileData);

  log.info(
    `Saved reminder ${reminder.id} for ${params.phone} scheduled at ${reminder.scheduled_for}`
  );
  return reminder;
}

/**
 * Update the status of a reminder by ID.
 */
export async function updateReminderStatus(
  phone: string,
  reminderId: string,
  status: ReminderStatus
): Promise<boolean> {
  const fileData = await readReminderFile(phone);
  const reminder = fileData.reminders.find((r) => r.id === reminderId);
  if (!reminder) {
    log.warn(`Reminder ${reminderId} not found for ${phone}`);
    return false;
  }
  reminder.status = status;
  await writeReminderFile(fileData);
  log.info(`Reminder ${reminderId} status updated to ${status}`);
  return true;
}

/**
 * Get all pending reminders for a specific phone.
 */
export async function getPendingReminders(phone: string): Promise<Reminder[]> {
  const fileData = await readReminderFile(phone);
  return fileData.reminders.filter((r) => r.status === "pending");
}

/**
 * Get all pending reminders across ALL users.
 * Used by the scheduler on startup to restore timeouts.
 */
export async function getAllPendingReminders(): Promise<Reminder[]> {
  await ensureRemindersDirExists();
  const { readdir } = await import("node:fs/promises");
  const dir = getRemindersDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const all: Reminder[] = [];
  for (const filename of files) {
    if (!filename.endsWith(".json") || filename.endsWith(".tmp.json")) continue;
    try {
      const raw = await readFile(join(dir, filename), "utf8");
      const fileData = JSON.parse(raw) as ReminderFile;
      const pending = fileData.reminders.filter((r) => r.status === "pending");
      all.push(...pending);
    } catch (err) {
      log.warn(`Could not read reminder file ${filename}: ${String(err)}`);
    }
  }

  return all;
}

/**
 * List reminders for a phone (only pending and sent, never reveals other users).
 */
export async function listReminders(
  phone: string,
  opts?: { statusFilter?: ReminderStatus[] }
): Promise<Reminder[]> {
  const fileData = await readReminderFile(phone);
  const statuses = opts?.statusFilter ?? ["pending"];
  return fileData.reminders.filter((r) => statuses.includes(r.status));
}
