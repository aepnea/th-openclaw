import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { getChildLogger } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { convertMarkdownTables } from "../markdown/tables.js";
import { markdownToWhatsApp } from "../markdown/whatsapp.js";
import { normalizePollInput, type PollInput } from "../polls.js";
import { toWhatsappJid } from "../utils.js";
import { type ActiveWebSendOptions, requireActiveWebListener } from "./active-listener.js";
import { loadWebMedia } from "./media.js";

const outboundLog = createSubsystemLogger("gateway/channels/whatsapp").child("outbound");

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: {
    verbose: boolean;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    gifPlayback?: boolean;
    accountId?: string;
  },
): Promise<{ messageId: string; toJid: string }> {
  let text = body;
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const { listener: active, accountId: resolvedAccountId } = requireActiveWebListener(
    options.accountId,
  );
  const cfg = loadConfig();
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "whatsapp",
    accountId: resolvedAccountId ?? options.accountId,
  });
  text = convertMarkdownTables(text ?? "", tableMode);
  text = markdownToWhatsApp(text);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to,
  });
  try {
    const jid = toWhatsappJid(to);
    let mediaBuffer: Buffer | undefined;
    let mediaType: string | undefined;
    let documentFileName: string | undefined;
    if (options.mediaUrl) {
      const media = await loadWebMedia(options.mediaUrl, {
        localRoots: options.mediaLocalRoots,
      });
      const caption = text || undefined;
      mediaBuffer = media.buffer;
      mediaType = media.contentType;
      if (media.kind === "audio") {
        // WhatsApp expects explicit opus codec for PTT voice notes.
        mediaType =
          media.contentType === "audio/ogg"
            ? "audio/ogg; codecs=opus"
            : (media.contentType ?? "application/octet-stream");
      } else if (media.kind === "video") {
        text = caption ?? "";
      } else if (media.kind === "image") {
        text = caption ?? "";
      } else {
        text = caption ?? "";
        documentFileName = media.fileName;
      }
    }
    outboundLog.info(`Sending message -> ${jid}${options.mediaUrl ? " (media)" : ""}`);
    logger.info({ jid, hasMedia: Boolean(options.mediaUrl) }, "sending message");
    await active.sendComposingTo(to);
    const hasExplicitAccountId = Boolean(options.accountId?.trim());
    const accountId = hasExplicitAccountId ? resolvedAccountId : undefined;
    const sendOptions: ActiveWebSendOptions | undefined =
      options.gifPlayback || accountId || documentFileName
        ? {
            ...(options.gifPlayback ? { gifPlayback: true } : {}),
            ...(documentFileName ? { fileName: documentFileName } : {}),
            accountId,
          }
        : undefined;
    const result = sendOptions
      ? await active.sendMessage(to, text, mediaBuffer, mediaType, sendOptions)
      : await active.sendMessage(to, text, mediaBuffer, mediaType);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(
      `Sent message ${messageId} -> ${jid}${options.mediaUrl ? " (media)" : ""} (${durationMs}ms)`,
    );
    logger.info({ jid, messageId }, "sent message");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error(
      { err: String(err), to, hasMedia: Boolean(options.mediaUrl) },
      "failed to send via web session",
    );
    throw err;
  }
}

export async function sendReactionWhatsApp(
  chatJid: string,
  messageId: string,
  emoji: string,
  options: {
    verbose: boolean;
    fromMe?: boolean;
    participant?: string;
    accountId?: string;
  },
): Promise<void> {
  const correlationId = randomUUID();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    chatJid,
    messageId,
  });
  try {
    const jid = toWhatsappJid(chatJid);
    outboundLog.info(`Sending reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: jid, messageId, emoji }, "sending reaction");
    await active.sendReaction(
      chatJid,
      messageId,
      emoji,
      options.fromMe ?? false,
      options.participant,
    );
    outboundLog.info(`Sent reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: jid, messageId, emoji }, "sent reaction");
  } catch (err) {
    logger.error(
      { err: String(err), chatJid, messageId, emoji },
      "failed to send reaction via web session",
    );
    throw err;
  }
}

export async function sendPollWhatsApp(
  to: string,
  poll: PollInput,
  options: { verbose: boolean; accountId?: string },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const { listener: active } = requireActiveWebListener(options.accountId);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to,
  });
  try {
    const jid = toWhatsappJid(to);
    const normalized = normalizePollInput(poll, { maxOptions: 12 });
    outboundLog.info(`Sending poll -> ${jid}: "${normalized.question}"`);
    logger.info(
      {
        jid,
        question: normalized.question,
        optionCount: normalized.options.length,
        maxSelections: normalized.maxSelections,
      },
      "sending poll",
    );
    const result = await active.sendPoll(to, normalized);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Sent poll ${messageId} -> ${jid} (${durationMs}ms)`);
    logger.info({ jid, messageId }, "sent poll");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error(
      { err: String(err), to, question: poll.question },
      "failed to send poll via web session",
    );
    throw err;
  }
}
/**
 * Send emergency alert messages to multiple recipients
 * Used for SOS feature - sends message to all stored emergency contacts
 * Process:
 * 1. Get active WhatsApp listener
 * 2. Iterate through emergency_numbers array
 * 3. Send message text to each number
 * 4. Collect success/failure results
 * 5. Return aggregate status for logging
 */
export async function sendEmergencyAlertWhatsApp(params: {
  sender_phone: string;
  emergency_numbers: string[];
  message: string;
  accountId?: string;
}): Promise<{
  success: boolean;
  sent_count: number;
  failed_count: number;
  failures: Array<{ number: string; error: string }>;
  timestamp: string;
  message_ids: string[];
}> {
  const correlationId = randomUUID();
  const logger = getChildLogger({
    module: "web-emergency-alert",
    correlationId,
    sender: params.sender_phone,
  });

  outboundLog.info(
    `[EMERGENCY] SOS activated by ${params.sender_phone}. Sending to ${params.emergency_numbers.length} contacts.`,
  );

  const results = {
    success: false,
    sent_count: 0,
    failed_count: 0,
    failures: [] as Array<{ number: string; error: string }>,
    timestamp: new Date().toISOString(),
    message_ids: [] as string[],
  };

  try {
    const { listener: active, accountId: resolvedAccountId } = requireActiveWebListener(
      params.accountId,
    );

    for (const phoneNumber of params.emergency_numbers) {
      try {
        // Validate phone number format (E.164)
        if (!/^\+\d{1,15}$/.test(phoneNumber)) {
          throw new Error(`Invalid phone format: ${phoneNumber}`);
        }

        outboundLog.info(`[EMERGENCY] Sending alert to ${phoneNumber}`);
        logger.info({ to: phoneNumber }, "sending emergency alert");

        const result = await active.sendMessage(phoneNumber, params.message);
        const messageId = (result as { messageId?: string })?.messageId ?? "unknown";

        results.sent_count++;
        results.message_ids.push(messageId);

        outboundLog.info(
          `[EMERGENCY] Alert sent to ${phoneNumber} (message: ${messageId})`,
        );
        logger.info({ to: phoneNumber, messageId }, "emergency alert sent");
      } catch (error) {
        results.failed_count++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.failures.push({
          number: phoneNumber,
          error: errorMsg,
        });

        outboundLog.warn(
          `[EMERGENCY] Failed to send alert to ${phoneNumber}: ${errorMsg}`,
        );
        logger.warn({ to: phoneNumber, error: errorMsg }, "emergency alert failed");
      }
    }

    results.success = results.failed_count === 0;

    outboundLog.info(
      `[EMERGENCY] SOS complete: ${results.sent_count}/${params.emergency_numbers.length} sent successfully`,
    );

    return results;
  } catch (err) {
    outboundLog.error(
      {
        err: String(err),
        sender: params.sender_phone,
        count: params.emergency_numbers.length,
      },
      "[EMERGENCY] Critical failure in emergency alert system",
    );
    logger.error({ err: String(err) }, "emergency alert system failure");

    // Return failure status but don't throw - allow Igor to report to user
    return {
      ...results,
      success: false,
      failed_count: params.emergency_numbers.length,
      failures: params.emergency_numbers.map((num) => ({
        number: num,
        error: String(err),
      })),
    };
  }
}