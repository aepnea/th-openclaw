import { BlacklistStorage, BlacklistEntry } from "../storage/blacklist-storage.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("blacklist-service");

/**
 * Validation result for blacklist operations
 */
export interface BlacklistValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: "INVALID_FORMAT" | "ALREADY_BLACKLISTED" | "INVALID_REASON" | "SYSTEM_ERROR";
}

/**
 * Query result when checking if a phone is blacklisted
 */
export interface BlacklistQueryResult {
  found: boolean;
  blocked_phone?: string;
  reason?: string;
  error?: string;
}

/**
 * Result of adding to blacklist
 */
export interface BlacklistAddResult {
  success: boolean;
  id?: string;
  blocked_phone?: string;
  reason?: string;
  timestamp?: string;
  error?: string;
  errorCode?: string;
}

/**
 * Service options
 */
export interface BlacklistServiceOptions {
  filePath: string;
  whitelistPhones: string[];  // List of authorized phones from WHITELIST.md
}

/**
 * Blacklist Service
 * Handles business logic for blacklist operations
 */
export class BlacklistService {
  private filePath: string;
  private whitelistPhones: string[];

  constructor(opts: BlacklistServiceOptions) {
    this.filePath = opts.filePath;
    this.whitelistPhones = opts.whitelistPhones;
    log.info(`Blacklist service initialized with ${opts.whitelistPhones.length} whitelisted numbers`);
  }

  /**
   * Validate phone number format (E.164)
   * Examples: +56912345678, +5619876543, +1234567890
   */
  private validatePhoneFormat(phone: string): boolean {
    // E.164 format: + followed by 1-15 digits
    const e164Regex = /^\+\d{1,15}$/;
    return e164Regex.test(phone);
  }

  /**
   * Validate reason text
   */
  private validateReason(reason: string): boolean {
    const trimmed = reason.trim();
    return trimmed.length > 0 && trimmed.length <= 200;
  }

  /**
   * Ensure blacklist file is initialized
   */
  private async ensureBlacklistInitialized(): Promise<void> {
    try {
      await BlacklistStorage.initializeBlacklistFile(this.filePath);
    } catch (err) {
      log.error(`Failed to initialize blacklist: ${String(err)}`);
      throw err;
    }
  }

  /**
   * Check if a phone number is whitelisted
   */
  private isWhitelisted(phone: string): boolean {
    return this.whitelistPhones.includes(phone);
  }

  /**
   * Validate and prepare before adding to blacklist
   */
  async validateAndPrepare(
    phone: string,
    reason: string,
    senderPhone: string
  ): Promise<BlacklistValidationResult> {
    // Check if sender is whitelisted
    if (!this.isWhitelisted(senderPhone)) {
      log.warn(`Unauthorized attempt to add to blacklist from: ${senderPhone}`);
      return {
        valid: false,
        error: "UNAUTHORIZED",
        errorCode: "INVALID_FORMAT",
      };
    }

    // Validate phone format
    if (!this.validatePhoneFormat(phone)) {
      log.warn(`Invalid phone format: ${phone}`);
      return {
        valid: false,
        error: "INVALID_PHONE_FORMAT",
        errorCode: "INVALID_FORMAT",
      };
    }

    // Validate reason
    if (!this.validateReason(reason)) {
      log.warn(`Invalid reason: too short or too long`);
      return {
        valid: false,
        error: "INVALID_REASON",
        errorCode: "INVALID_REASON",
      };
    }

    // Ensure blacklist is initialized
    try {
      await this.ensureBlacklistInitialized();
    } catch (err) {
      return {
        valid: false,
        error: "SYSTEM_ERROR",
        errorCode: "SYSTEM_ERROR",
      };
    }

    // Check if already blacklisted
    try {
      const exists = await BlacklistStorage.entryExists(this.filePath, phone);
      if (exists) {
        log.info(`Phone already blacklisted: ${phone}`);
        return {
          valid: false,
          error: "ALREADY_BLACKLISTED",
          errorCode: "ALREADY_BLACKLISTED",
        };
      }
    } catch (err) {
      log.error(`Error checking if phone exists: ${String(err)}`);
      return {
        valid: false,
        error: "SYSTEM_ERROR",
        errorCode: "SYSTEM_ERROR",
      };
    }

    return { valid: true };
  }

  /**
   * Add a phone number to the blacklist
   */
  async addToBlacklist(
    phone: string,
    reason: string,
    senderPhone: string
  ): Promise<BlacklistAddResult> {
    try {
      // Validate input
      const validation = await this.validateAndPrepare(phone, reason, senderPhone);
      if (!validation.valid) {
        log.warn(`Validation failed for add: ${validation.error}`);
        return {
          success: false,
          error: validation.error,
          errorCode: validation.errorCode,
        };
      }

      // Add to blacklist
      const entry = await BlacklistStorage.appendEntry(this.filePath, {
        blocked_phone: phone,
        reason: reason.trim(),
        added_by_phone: senderPhone,
      });

      log.info(`Successfully added phone to blacklist: ${phone}`);
      return {
        success: true,
        id: entry.id,
        blocked_phone: entry.blocked_phone,
        reason: entry.reason,
        timestamp: entry.timestamp,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to add to blacklist: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        errorCode: "SYSTEM_ERROR",
      };
    }
  }

  /**
   * Check if a phone number is blacklisted
   * Returns only blocked_phone and reason (does NOT expose added_by_phone)
   */
  async checkBlacklist(phone: string): Promise<BlacklistQueryResult> {
    try {
      // Validate phone format
      if (!this.validatePhoneFormat(phone)) {
        log.warn(`Invalid phone format in check: ${phone}`);
        return {
          found: false,
          error: "INVALID_PHONE_FORMAT",
        };
      }

      // Ensure blacklist initialized
      await this.ensureBlacklistInitialized();

      // Search for phone
      const entry = await BlacklistStorage.findByPhone(this.filePath, phone);

      if (entry) {
        log.info(`Blacklist check - found: ${phone}`);
        return {
          found: true,
          blocked_phone: entry.blocked_phone,
          reason: entry.reason,
        };
      }

      log.info(`Blacklist check - not found: ${phone}`);
      return {
        found: false,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to check blacklist: ${errorMsg}`);
      return {
        found: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Get blacklist statistics (for internal monitoring)
   */
  async getStats(): Promise<{ total_entries: number; last_updated: string }> {
    try {
      await this.ensureBlacklistInitialized();
      return await BlacklistStorage.getStats(this.filePath);
    } catch (err) {
      log.error(`Failed to get stats: ${String(err)}`);
      throw err;
    }
  }

  /**
   * Update whitelist of authorized phones
   */
  updateWhitelist(phones: string[]): void {
    this.whitelistPhones = phones;
    log.info(`Whitelist updated with ${phones.length} authorized numbers`);
  }
}
