import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const TOKEN_LIFETIME = "30d";

export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const checkPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

export function signToken(userId: number, secret: string) {
  return jwt.sign({ sub: String(userId) }, secret, { expiresIn: TOKEN_LIFETIME });
}

export function verifyToken(token: string, secret: string): number | null {
  try {
    const payload = jwt.verify(token, secret);
    if (typeof payload === "object" && payload.sub) return Number(payload.sub);
    return null;
  } catch {
    return null;
  }
}

// API keys look like "cd_<random>". Only a SHA-256 hash is stored.
export function generateApiKey() {
  const key = "cd_" + crypto.randomBytes(24).toString("base64url");
  return { key, prefix: key.slice(0, 8), hash: hashApiKey(key) };
}

export const hashApiKey = (key: string) => crypto.createHash("sha256").update(key).digest("hex");
