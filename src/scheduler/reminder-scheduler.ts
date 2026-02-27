/**
 * Reminder Scheduler
 *
 * Module-level singleton responsible for:
 * 1. On startup: loading all pending reminders and scheduling setTimeout for each
 * 2. On new reminder (via scheduleReminder): registering a new setTimeout
 * 3. When a timeout fires: sending the WhatsApp message, then marking as sent
 *
 * Why setTimeout and not cron/setInterval:
 * - Reminders are precise ("in 30 minutes"), not recurring
 * - setTimeout is the simplest reliable mechanism for one-shot delays
 * - On restart, we reload pending reminders and re-schedule with remaining delay
 *
 * Privacy guarantee:
 * - Each send is scoped to the owner's phone — never cross-user
 * - Scheduler never reads other users' reminders on behalf of a user
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { sendMessageWhatsApp } from "../web/outbound.js";
import {
  getAllPendingReminders,
  updateReminderStatus,
  type Reminder,
} from "../storage/reminder-storage.js";

const log = createSubsystemLogger("reminder-scheduler");

// Max delay Node.js handles correctly in setTimeout (~24.8 days)
const MAX_TIMEOUT_MS = 2_147_483_647;

class ReminderScheduler {
  private initialized = false;
  private activeTimers = new Map<string, NodeJS.Timeout>();

  /** Initialize once: load all pending reminders and schedule them. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      const pending = await getAllPendingReminders();
      log.info(`Scheduler init: found ${pending.length} pending reminder(s)`);
      for (const reminder of pending) {
        this.scheduleReminder(reminder);
      }
    } catch (err) {
      log.error(`Scheduler init failed: ${String(err)}`);
    }
  }

  /**
   * Schedule a reminder. Safe to call multiple times (deduplicates by id).
   * Should be called after saving a new reminder to storage.
   */
  scheduleReminder(reminder: Reminder): void {
    // Cancel any existing timer for this id (prevents duplicates on re-init)
    if (this.activeTimers.has(reminder.id)) {
      clearTimeout(this.activeTimers.get(reminder.id)!);
      this.activeTimers.delete(reminder.id);
    }

    const targetTime = new Date(reminder.scheduled_for).getTime();
    const delayMs = Math.max(0, targetTime - Date.now());

    if (delayMs > MAX_TIMEOUT_MS) {
      // For very distant reminders, re-schedule in smaller chunks
      log.info(
        `Reminder ${reminder.id} is far in the future (${delayMs}ms). Will reschedule after ${MAX_TIMEOUT_MS}ms`
      );
      const timer = setTimeout(() => {
        this.activeTimers.delete(reminder.id);
        this.scheduleReminder(reminder); // re-evaluate remaining delay
      }, MAX_TIMEOUT_MS);
      this.activeTimers.set(reminder.id, timer);
      return;
    }

    log.info(
      `Scheduling reminder ${reminder.id} for ${reminder.phone} in ${Math.round(delayMs / 1000)}s (at ${reminder.scheduled_for})`
    );

    const timer = setTimeout(async () => {
      this.activeTimers.delete(reminder.id);
      await this.fireReminder(reminder);
    }, delayMs);

    this.activeTimers.set(reminder.id, timer);
  }

  /**
   * Cancel a scheduled reminder by id (e.g. if user cancels it).
   */
  cancelReminder(reminderId: string): boolean {
    const timer = this.activeTimers.get(reminderId);
    if (!timer) return false;
    clearTimeout(timer);
    this.activeTimers.delete(reminderId);
    log.info(`Reminder ${reminderId} timer cancelled`);
    return true;
  }

  /** Fire: send the WhatsApp message and update storage status. */
  private async fireReminder(reminder: Reminder): Promise<void> {
    log.info(`Firing reminder ${reminder.id} for ${reminder.phone}`);

    try {
      await sendMessageWhatsApp(reminder.phone, reminder.formatted_send_message, {
        verbose: false,
        accountId: reminder.account_id,
      });

      await updateReminderStatus(reminder.phone, reminder.id, "sent");
      log.info(`Reminder ${reminder.id} sent successfully to ${reminder.phone}`);
    } catch (err) {
      log.error(`Failed to send reminder ${reminder.id} to ${reminder.phone}: ${String(err)}`);
      try {
        await updateReminderStatus(reminder.phone, reminder.id, "failed");
      } catch {
        // best effort
      }
    }
  }

  /** Number of currently active timers (for diagnostics). */
  get activeCount(): number {
    return this.activeTimers.size;
  }
}

// Module-level singleton — shared across all tool invocations in the same process
const reminderScheduler = new ReminderScheduler();

// Auto-initialize on first module import (non-blocking)
reminderScheduler.init().catch((err) => {
  log.error(`Auto-init of reminder scheduler failed: ${String(err)}`);
});

export { reminderScheduler };
