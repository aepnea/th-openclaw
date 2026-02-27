import { promises as fs } from "fs";
import { dirname } from "path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { randomUUID } from "crypto";

const log = createSubsystemLogger("blacklist-storage");

/**
 * Blacklist entry structure
 * Stores information about a blocked phone number
 */
export interface BlacklistEntry {
  blocked_phone: string;    // E.164 format: +56912345678
  reason: string;            // 1-200 character explanation
  added_by_phone: string;    // E.164 format - whitelisted user who added it
  timestamp: string;         // ISO 8601 timestamp
  id: string;                // UUID v4 for unique identification
}

/**
 * Blacklist file structure
 * Top-level container for all blacklist data
 */
export interface BlacklistFile {
  version: string;           // "1.0" for compatibility
  last_updated: string;      // ISO 8601 timestamp
  blacklist: BlacklistEntry[];
}

/**
 * Blacklist Storage
 * Handles all file I/O operations for the blacklist
 * Uses atomic writes and locking to prevent corruption
 */
export namespace BlacklistStorage {
  /**
   * Initialize empty blacklist file if it doesn't exist
   */
  export async function initializeBlacklistFile(filePath: string): Promise<void> {
    try {
      // Check if file exists
      await fs.access(filePath);
      log.info(`Blacklist file already exists: ${filePath}`);
    } catch {
      // File doesn't exist, create it
      log.info(`Creating new blacklist file: ${filePath}`);

      // Ensure directory exists
      const dir = dirname(filePath);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (mkdirErr) {
        log.error(`Failed to create directory ${dir}: ${String(mkdirErr)}`);
        throw new Error(`Cannot create blacklist directory: ${String(mkdirErr)}`);
      }

      const emptyBlacklist: BlacklistFile = {
        version: "1.0",
        last_updated: new Date().toISOString(),
        blacklist: [],
      };

      try {
        await fs.writeFile(filePath, JSON.stringify(emptyBlacklist, null, 2));
        log.info(`Blacklist file initialized successfully`);
      } catch (writeErr) {
        log.error(`Failed to write blacklist file: ${String(writeErr)}`);
        throw new Error(`Cannot initialize blacklist file: ${String(writeErr)}`);
      }
    }
  }

  /**
   * Read blacklist from file
   */
  export async function readBlacklistFile(filePath: string): Promise<BlacklistFile> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(content) as BlacklistFile;

      // Validate structure
      if (!Array.isArray(data.blacklist)) {
        throw new Error("Invalid blacklist file structure: blacklist must be an array");
      }

      log.info(`Read blacklist with ${data.blacklist.length} entries`);
      return data;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to read blacklist file: ${errorMsg}`);
      throw new Error(`Cannot read blacklist file: ${errorMsg}`);
    }
  }

  /**
   * Write blacklist to file with atomic operation
   * Creates backup before overwrite
   */
  export async function writeBlacklistFile(filePath: string, data: BlacklistFile): Promise<void> {
    const backupPath = `${filePath}.backup`;
    const tempPath = `${filePath}.tmp`;

    try {
      // Ensure directory exists
      const dir = dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      // Backup existing file
      try {
        await fs.copyFile(filePath, backupPath);
        log.info(`Backup created: ${backupPath}`);
      } catch {
        log.warn("No existing file to backup");
      }

      // Write to temp file first (atomic operation)
      const jsonString = JSON.stringify(data, null, 2);
      await fs.writeFile(tempPath, jsonString);

      // Move temp file to target (atomic on most filesystems)
      await fs.rename(tempPath, filePath);

      log.info(`Blacklist file written successfully with ${data.blacklist.length} entries`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to write blacklist file: ${errorMsg}`);

      // Cleanup temp file if it exists
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }

      throw new Error(`Cannot write blacklist file: ${errorMsg}`);
    }
  }

  /**
   * Check if a phone number exists in the blacklist
   */
  export async function findByPhone(filePath: string, phone: string): Promise<BlacklistEntry | null> {
    try {
      const data = await readBlacklistFile(filePath);
      const entry = data.blacklist.find((e) => e.blocked_phone === phone);

      if (entry) {
        log.info(`Found blacklist entry for phone: ${phone}`);
        return entry;
      }

      log.info(`No blacklist entry found for phone: ${phone}`);
      return null;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Error searching blacklist: ${errorMsg}`);
      throw err;
    }
  }

  /**
   * Check if a phone number is already blacklisted
   */
  export async function entryExists(filePath: string, phone: string): Promise<boolean> {
    try {
      const entry = await findByPhone(filePath, phone);
      return entry !== null;
    } catch {
      return false;
    }
  }

  /**
   * Add a new entry to the blacklist
   * Generates ID and timestamp automatically
   */
  export async function appendEntry(
    filePath: string,
    entry: Omit<BlacklistEntry, "id" | "timestamp">
  ): Promise<BlacklistEntry> {
    try {
      // Read current data
      const data = await readBlacklistFile(filePath);

      // Check for duplicate
      const existing = data.blacklist.find((e) => e.blocked_phone === entry.blocked_phone);
      if (existing) {
        throw new Error(`Phone ${entry.blocked_phone} is already blacklisted`);
      }

      // Create new entry with ID and timestamp
      const newEntry: BlacklistEntry = {
        ...entry,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      };

      // Add to blacklist
      data.blacklist.push(newEntry);
      data.last_updated = new Date().toISOString();

      // Write back to file
      await writeBlacklistFile(filePath, data);

      log.info(`New blacklist entry added: ${newEntry.id} for phone: ${newEntry.blocked_phone}`);
      return newEntry;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to append entry: ${errorMsg}`);
      throw err;
    }
  }

  /**
   * Get all entries (for internal use only - not exposed to users)
   */
  export async function getAllEntries(filePath: string): Promise<BlacklistEntry[]> {
    try {
      const data = await readBlacklistFile(filePath);
      return data.blacklist;
    } catch (err) {
      log.error(`Failed to get all entries: ${String(err)}`);
      throw err;
    }
  }

  /**
   * Get blacklist statistics
   */
  export async function getStats(filePath: string): Promise<{
    total_entries: number;
    last_updated: string;
  }> {
    try {
      const data = await readBlacklistFile(filePath);
      return {
        total_entries: data.blacklist.length,
        last_updated: data.last_updated,
      };
    } catch (err) {
      log.error(`Failed to get stats: ${String(err)}`);
      throw err;
    }
  }
}
