/**
 * Field-level AES-256-GCM encryption for sensitive payloads.
 *
 * Important deviation from the rough spec: the spec used the deprecated
 * `crypto.createCipher`, which silently ignores the IV and is unsuitable
 * for GCM. We use `createCipheriv` + `pbkdf2Sync` per the documented
 * Node.js best practice. The wire format (`EncryptedField`) is unchanged.
 */

import * as crypto from "crypto";

export interface EncryptedField {
  encrypted: string;
  iv: string;
  authTag: string;
  algorithm: string;
  keyVersion?: number;
}

const ALG = "aes-256-gcm";
const KEY_LEN = 32;
const PBKDF2_ITERS = 100_000;

export class FieldEncryption {
  private masterKey: string;
  private isTempKey = false;

  constructor(masterKey?: string) {
    const provided = masterKey || process.env.FIELD_ENCRYPTION_KEY;
    if (provided) {
      this.masterKey = provided;
    } else {
      this.masterKey = crypto.randomBytes(32).toString("hex");
      this.isTempKey = true;
      if (process.env.NODE_ENV === "production") {
        console.warn(
          "[Encryption] FIELD_ENCRYPTION_KEY not set in production — using ephemeral key. Data will not survive restart.",
        );
      }
    }
  }

  /** True if running on an ephemeral, in-process key. */
  get isEphemeral(): boolean {
    return this.isTempKey;
  }

  encrypt(plaintext: string, additionalData?: string): EncryptedField {
    const iv = crypto.randomBytes(12); // 96-bit IV is the GCM standard
    const key = crypto.pbkdf2Sync(this.masterKey, iv, PBKDF2_ITERS, KEY_LEN, "sha256");
    const cipher = crypto.createCipheriv(ALG, key, iv);
    if (additionalData) cipher.setAAD(Buffer.from(additionalData));

    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      encrypted: enc.toString("hex"),
      iv: iv.toString("hex"),
      authTag: cipher.getAuthTag().toString("hex"),
      algorithm: ALG,
      keyVersion: 1,
    };
  }

  decrypt(field: EncryptedField, additionalData?: string): string {
    const iv = Buffer.from(field.iv, "hex");
    const key = crypto.pbkdf2Sync(this.masterKey, iv, PBKDF2_ITERS, KEY_LEN, "sha256");
    const decipher = crypto.createDecipheriv(field.algorithm || ALG, key, iv);
    decipher.setAuthTag(Buffer.from(field.authTag, "hex"));
    if (additionalData) decipher.setAAD(Buffer.from(additionalData));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(field.encrypted, "hex")),
      decipher.final(),
    ]);
    return dec.toString("utf8");
  }

  isEncrypted(value: unknown): value is EncryptedField {
    return (
      typeof value === "object" &&
      value !== null &&
      "encrypted" in (value as any) &&
      "iv" in (value as any) &&
      "authTag" in (value as any)
    );
  }
}
