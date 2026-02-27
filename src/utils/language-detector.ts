import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("language-detector");

/**
 * Supported languages for Igor
 */
export type Language = "es" | "en" | "pt";

/**
 * Language Detection Utility
 * Detects conversation language from user messages
 */
export namespace LanguageDetector {
  /**
   * Spanish keywords and indicators
   */
  const SPANISH_KEYWORDS = [
    "sos",
    "ayuda",
    "agregar",
    "bloquear",
    "verificar",
    "si",
    "sí",
    "no",
    "por favor",
    "motivo",
    "razón",
    "número",
    "contacto",
    "emergencia",
    "teléfono",
    "confirmar",
    "cancelar",
    "blocklist",
    "lista negra",
  ];

  /**
   * English keywords and indicators
   */
  const ENGLISH_KEYWORDS = [
    "sos",
    "help",
    "add",
    "block",
    "check",
    "yes",
    "no",
    "please",
    "reason",
    "number",
    "contact",
    "emergency",
    "phone",
    "confirm",
    "cancel",
    "blacklist",
    "lookup",
    "is blacklisted",
  ];

  /**
   * Portuguese keywords and indicators
   */
  const PORTUGUESE_KEYWORDS = [
    "sos",
    "ajuda",
    "adicionar",
    "bloquear",
    "verificar",
    "sim",
    "não",
    "por favor",
    "motivo",
    "razão",
    "número",
    "contato",
    "emergência",
    "telefone",
    "confirmar",
    "cancelar",
    "lista negra",
  ];

  /**
   * Detect language from text
   * Uses keyword matching and heuristics
   */
  export function detectFromText(text: string): Language {
    if (!text || typeof text !== "string") {
      log.warn("Invalid text for language detection, defaulting to Spanish");
      return "es";
    }

    const lowerText = text.toLowerCase();

    // Count keyword matches for each language
    const spanishMatches = SPANISH_KEYWORDS.filter((kw) => lowerText.includes(kw)).length;
    const englishMatches = ENGLISH_KEYWORDS.filter((kw) => lowerText.includes(kw)).length;
    const portugueseMatches = PORTUGUESE_KEYWORDS.filter((kw) => lowerText.includes(kw)).length;

    log.debug(`Language detection scores - ES: ${spanishMatches}, EN: ${englishMatches}, PT: ${portugueseMatches}`);

    // Determine language by highest score
    if (spanishMatches > englishMatches && spanishMatches > portugueseMatches && spanishMatches > 0) {
      log.info("Detected language: Spanish");
      return "es";
    }

    if (englishMatches > spanishMatches && englishMatches > portugueseMatches && englishMatches > 0) {
      log.info("Detected language: English");
      return "en";
    }

    if (portugueseMatches > spanishMatches && portugueseMatches > englishMatches && portugueseMatches > 0) {
      log.info("Detected language: Portuguese");
      return "pt";
    }

    // Additional heuristics for common patterns
    if (lowerText.includes("¿") || lowerText.includes("¡")) {
      log.info("Detected Spanish by punctuation");
      return "es";
    }

    // Default to Spanish if no clear detection
    log.info("No clear language detected, defaulting to Spanish");
    return "es";
  }

  /**
   * Detect language from conversation history
   * Uses the most recent user message
   */
  export function detectFromConversation(messages: Array<{ role: string; content: string }>): Language {
    // Find the most recent user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user" || message.role === "incoming") {
        return detectFromText(message.content);
      }
    }

    // Default if no user messages found
    log.warn("No user messages in conversation, defaulting to Spanish");
    return "es";
  }

  /**
   * Get the default language
   */
  export function getDefault(): Language {
    return "es";
  }

  /**
   * Check if language is valid
   */
  export function isValid(lang: unknown): lang is Language {
    return lang === "es" || lang === "en" || lang === "pt";
  }

  /**
   * Convert language code to readable name
   */
  export function getName(lang: Language): string {
    switch (lang) {
      case "es":
        return "Spanish";
      case "en":
        return "English";
      case "pt":
        return "Portuguese";
      default:
        return "Unknown";
    }
  }
}
