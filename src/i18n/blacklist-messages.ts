import { Language } from "../utils/language-detector.js";

/**
 * Multilingual Messages for Blacklist Feature
 * Supports Spanish, English, and Portuguese
 */

export interface BlacklistMessageSet {
  // Add to blacklist workflow
  addInitialRequest: string;
  addReasonPrompt: string;
  addConfirmation: string;
  addSuccess: string;
  addCancelled: string;
  addAlreadyBlacklisted: string;

  // Check blacklist workflow
  checkRequest: string;
  checkFound: string;
  checkNotFound: string;

  // Errors
  errorInvalidFormat: string;
  errorUnauthorized: string;
  errorSystem: string;
  errorAlreadyBlacklisted: string;
  errorInvalidReason: string;

  // Forbidden access
  denialFullList: string;
}

const MESSAGES: Record<Language, BlacklistMessageSet> = {
  es: {
    // Add to blacklist workflow
    addInitialRequest:
      "Puedo ayudarte a agregar un número a la lista negra. Por favor proporciona el número en formato E.164 (ej. +5691234567).",
    addReasonPrompt:
      "Por favor proporciona el motivo por el cual este número debe ser bloqueado (ej. spam, acoso, comportamiento inapropiado).",
    addConfirmation: `📋 **Confirmar entrada en lista negra**:
- **Teléfono**: {phone}
- **Motivo**: {reason}

Responde **SÍ** para confirmar o cualquier otra cosa para cancelar.`,
    addSuccess: "✅ El número {phone} ha sido agregado a la lista negra. Será verificado en futuras interacciones.",
    addCancelled: "❌ Operación cancelada. No se realizaron cambios.",
    addAlreadyBlacklisted:
      "⚠️ Este número ya está en la lista negra. Motivo: {reason}. ¿Deseas agregar una nota adicional?",

    // Check blacklist workflow
    checkRequest:
      "Por favor proporciona el número que deseas verificar en formato E.164 (ej. +5691234567).",
    checkFound: "⚠️ Este número está en la lista negra. Motivo: {reason}",
    checkNotFound: "✅ Este número no está en la lista negra.",

    // Errors
    errorInvalidFormat:
      "Por favor proporciona el número en formato E.164 (ej. +5691234567, con el símbolo + y el código de país).",
    errorUnauthorized: "No estás autorizado para usar esta función.",
    errorSystem: "No se puede procesar la solicitud. Por favor intenta más tarde.",
    errorAlreadyBlacklisted: "Este número ya está en la lista negra.",
    errorInvalidReason: "El motivo debe tener entre 1 y 200 caracteres.",

    // Forbidden access
    denialFullList:
      "No puedo proporcionar la lista negra completa. Solo puedes verificar números individuales. Si necesitas verificar un número específico, pregunta: '¿Está {phone} en la lista negra?'",
  },

  en: {
    // Add to blacklist workflow
    addInitialRequest:
      "I can help you add a phone number to the blacklist. Please provide the phone number in E.164 format (e.g., +5691234567).",
    addReasonPrompt:
      "Please provide the reason why this number should be blocked (e.g., spam, harassment, inappropriate behavior).",
    addConfirmation: `📋 **Confirm Blacklist Entry**:
- **Phone**: {phone}
- **Reason**: {reason}

Reply **YES** to confirm or anything else to cancel.`,
    addSuccess:
      "✅ Phone number {phone} has been added to the blacklist. It will be checked on future interactions.",
    addCancelled: "❌ Operation cancelled. No changes made.",
    addAlreadyBlacklisted:
      "⚠️ This number is already on the blacklist. Reason: {reason}. Would you like to add an additional note?",

    // Check blacklist workflow
    checkRequest: "Please provide the phone number you'd like to check in E.164 format (e.g., +5691234567).",
    checkFound: "⚠️ This phone number is blacklisted. Reason: {reason}",
    checkNotFound: "✅ This phone number is not on the blacklist.",

    // Errors
    errorInvalidFormat:
      "Please provide the phone number in E.164 format (e.g., +5691234567, with + symbol and country code).",
    errorUnauthorized: "You are not authorized to use this feature.",
    errorSystem: "Unable to process the request. Please try again later.",
    errorAlreadyBlacklisted: "This number is already on the blacklist.",
    errorInvalidReason: "The reason must be between 1 and 200 characters.",

    // Forbidden access
    denialFullList:
      "I cannot provide the full blacklist. You can only check individual phone numbers. If you need to verify a specific number, please ask: 'Is {phone} blacklisted?'",
  },

  pt: {
    // Add to blacklist workflow
    addInitialRequest:
      "Posso ajudá-lo a adicionar um número à lista negra. Por favor forneça o número em formato E.164 (ex. +5691234567).",
    addReasonPrompt:
      "Por favor forneça o motivo pelo qual este número deve ser bloqueado (ex. spam, assédio, comportamento inadequado).",
    addConfirmation: `📋 **Confirmar entrada na lista negra**:
- **Telefone**: {phone}
- **Motivo**: {reason}

Responda **SIM** para confirmar ou qualquer outra coisa para cancelar.`,
    addSuccess: "✅ O número {phone} foi adicionado à lista negra. Será verificado em futuras interações.",
    addCancelled: "❌ Operação cancelada. Nenhuma alteração foi feita.",
    addAlreadyBlacklisted:
      "⚠️ Este número já está na lista negra. Motivo: {reason}. Gostaria de adicionar uma nota adicional?",

    // Check blacklist workflow
    checkRequest: "Por favor forneça o número que deseja verificar em formato E.164 (ex. +5691234567).",
    checkFound: "⚠️ Este número está na lista negra. Motivo: {reason}",
    checkNotFound: "✅ Este número não está na lista negra.",

    // Errors
    errorInvalidFormat:
      "Por favor forneça o número em formato E.164 (ex. +5691234567, com o símbolo + e código do país).",
    errorUnauthorized: "Você não está autorizado a usar este recurso.",
    errorSystem: "Não é possível processar a solicitação. Por favor, tente novamente mais tarde.",
    errorAlreadyBlacklisted: "Este número já está na lista negra.",
    errorInvalidReason: "O motivo deve ter entre 1 e 200 caracteres.",

    // Forbidden access
    denialFullList:
      "Não posso fornecer a lista negra completa. Você só pode verificar números individuais. Se precisar verificar um número específico, pergunte: '{phone} está na lista negra?'",
  },
};

/**
 * Get a message in the specified language
 */
export function getBlacklistMessage(
  messageKey: keyof BlacklistMessageSet,
  language: Language,
  variables?: Record<string, string>
): string {
  const messageSet = MESSAGES[language];
  let message = messageSet[messageKey] || `[Missing message: ${messageKey}]`;

  // Replace variables like {phone}, {reason}
  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      message = message.replace(new RegExp(`{${key}}`, "g"), value);
    }
  }

  return message;
}

/**
 * Get all messages for a language
 */
export function getAllBlacklistMessages(language: Language): BlacklistMessageSet {
  return MESSAGES[language];
}
