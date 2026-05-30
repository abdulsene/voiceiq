/**
 * PII detection + redaction for call transcripts and arbitrary text.
 * Detects phone, email, SSN, credit card, address, names, and DOB and
 * returns either redacted text or encrypted-at-rest forms recoverable
 * via FieldEncryption.
 */

import { FieldEncryption, type EncryptedField } from "./encryption.js";

export type PIIType =
  | "phone"
  | "email"
  | "ssn"
  | "credit_card"
  | "address"
  | "name"
  | "date_of_birth";

export interface PIIDetection {
  type: PIIType;
  instances: string[];
  count: number;
  confidence: number;
}

export interface PIIProcessingResult {
  original: string;
  redacted: string;
  detections: PIIDetection[];
  encrypted: Record<string, EncryptedField>;
}

const BASE_CONFIDENCE: Record<PIIType, number> = {
  email: 0.95,
  ssn: 0.95,
  phone: 0.9,
  credit_card: 0.9,
  date_of_birth: 0.8,
  address: 0.75,
  name: 0.6,
};

const REDACTION: Record<PIIType, string> = {
  phone: "***-***-****",
  email: "***@***.***",
  ssn: "***-**-****",
  credit_card: "****-****-****-****",
  address: "[REDACTED-ADDRESS]",
  name: "[REDACTED-NAME]",
  date_of_birth: "**/**/****",
};

export class PIIProcessor {
  // Patterns must be created fresh per call (global flag is stateful) so
  // they're built inside the methods, not stored as instance state.
  private static patterns(): Record<PIIType, RegExp> {
    return {
      // Matches either parenthesized "(415) 555-1212" or "415-555-1212",
      // optional country code. The leading `(?<!\d)` prevents grabbing the
      // tail of a longer digit run.
      phone:
        /(?<!\d)(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]?\d{4}(?!\d)/g,
      email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      ssn: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
      // Allow spaces/hyphens between 4-digit groups so "4111 1111 1111 1111"
      // and "4111-1111-1111-1111" both match. Strip separators before the
      // brand check is unnecessary because we anchor by Visa/MC/Amex/Disc IINs.
      credit_card:
        /\b(?:4\d{3}([-\s]?)\d{4}\1\d{4}\1\d{4}|5[1-5]\d{2}([-\s]?)\d{4}\2\d{4}\2\d{4}|3[47]\d{2}([-\s]?)\d{6}\3\d{5}|6(?:011|5\d{2})([-\s]?)\d{4}\4\d{4}\4\d{4})\b/g,
      // House number + 1–4 capitalized words + suffix. Avoids back-tracking
      // across long sentences (the previous pattern was greedy enough to
      // pull in a full sentence between a digit and the next "Street").
      address:
        /\b\d{1,6}\s+(?:[A-Z][A-Za-z0-9.'-]{0,20}\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Way|Highway|Hwy)\b\.?/g,
      name: /\b[A-Z][a-z]{1,15}\s+[A-Z][a-z]{1,15}\b/g,
      date_of_birth:
        /\b(?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12][0-9]|3[01])[-/](?:19|20)\d{2}\b/g,
    };
  }

  private encryption: FieldEncryption;

  constructor(encryption?: FieldEncryption) {
    this.encryption = encryption || new FieldEncryption();
  }

  detectPII(text: string): PIIDetection[] {
    if (!text) return [];
    const detections: PIIDetection[] = [];
    for (const [type, pattern] of Object.entries(PIIProcessor.patterns())) {
      const matches = Array.from(text.matchAll(pattern));
      if (matches.length === 0) continue;
      detections.push({
        type: type as PIIType,
        instances: matches.map((m) => m[0]),
        count: matches.length,
        confidence: BASE_CONFIDENCE[type as PIIType] ?? 0.7,
      });
    }
    return detections;
  }

  /**
   * Redact PII in priority order (most specific first) so that phone/SSN
   * matches inside a longer "name" line aren't double-counted. Encrypts
   * each redacted instance for later recovery via FieldEncryption.
   */
  redactPII(text: string): PIIProcessingResult {
    if (!text) {
      return { original: text, redacted: text, detections: [], encrypted: {} };
    }
    const order: PIIType[] = [
      "credit_card",
      "ssn",
      "email",
      "phone",
      "date_of_birth",
      "address",
      "name",
    ];
    const detections: PIIDetection[] = [];
    const encrypted: Record<string, EncryptedField> = {};
    let redacted = text;
    const patterns = PIIProcessor.patterns();
    let counter = 0;

    for (const type of order) {
      const matches = Array.from(redacted.matchAll(patterns[type]));
      if (matches.length === 0) continue;
      const instances = matches.map((m) => m[0]);
      detections.push({
        type,
        instances,
        count: matches.length,
        confidence: BASE_CONFIDENCE[type],
      });
      for (const raw of instances) {
        try {
          encrypted[`${type}_${counter++}`] = this.encryption.encrypt(raw, `pii_${type}`);
        } catch (err) {
          // If encryption fails (e.g., key load error), continue with redaction.
          console.error(`[PII] encrypt failed for ${type}:`, (err as Error).message);
        }
      }
      redacted = redacted.replace(patterns[type], REDACTION[type]);
    }

    return { original: text, redacted, detections, encrypted };
  }

  encryptSensitiveFields<T extends Record<string, any>>(
    data: T,
    sensitiveFields: string[],
  ): T {
    const result: Record<string, any> = { ...data };
    for (const field of sensitiveFields) {
      if (typeof result[field] === "string") {
        result[field] = this.encryption.encrypt(result[field], field);
      }
    }
    return result as T;
  }

  decryptSensitiveFields<T extends Record<string, any>>(
    data: T,
    sensitiveFields: string[],
  ): T {
    const result: Record<string, any> = { ...data };
    for (const field of sensitiveFields) {
      if (this.encryption.isEncrypted(result[field])) {
        try {
          result[field] = this.encryption.decrypt(result[field], field);
        } catch (err) {
          console.error(`[PII] decrypt failed for ${field}:`, (err as Error).message);
          result[field] = "[DECRYPTION_ERROR]";
        }
      }
    }
    return result as T;
  }
}
