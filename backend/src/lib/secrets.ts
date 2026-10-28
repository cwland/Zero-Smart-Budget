import crypto from "node:crypto";

// Encrypts small secrets (like the SMTP password) before they go in the database.
// The key comes from JWT_SECRET, so a stolen database dump alone doesn't reveal them.
// If JWT_SECRET changes, old secrets can't be read and just need re-entering.
const keyFrom = (secret: string) => crypto.createHash("sha256").update(`${secret}:app-settings`).digest();

export function encryptSecret(plain: string, secret: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(stored: string, secret: string): string | null {
  try {
    const [v, iv, tag, data] = stored.split(":");
    if (v !== "v1") return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
