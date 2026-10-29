import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { api } from "./api";
import type { User } from "./session";

// Passkeys need a browser that supports them and a secure address (https://, or localhost)
export const passkeysAvailable = () => browserSupportsWebAuthn() && window.isSecureContext;

// The browser's own errors, in plain words. null: you cancelled (say nothing)
export function passkeyError(e: unknown): string | null {
  const name = (e as Error)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return null;
  if (e instanceof WebAuthnError && e.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return "This device's passkey is already added.";
  return (e as Error)?.message || "The passkey didn't work.";
}

export async function signInWithPasskey() {
  const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("POST", "/api/auth/passkey/login/options", {});
  const response = await startAuthentication({ optionsJSON: options });
  return api<{ token: string; user: User }>("POST", "/api/auth/passkey/login/verify", { challengeId, response });
}

export async function addPasskey(name?: string) {
  const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("POST", "/api/auth/passkeys/register/options", {});
  const response = await startRegistration({ optionsJSON: options });
  return api<{ id: number; name: string; rpId: string }>("POST", "/api/auth/passkeys/register/verify", { challengeId, response, name: name?.trim() || undefined });
}
