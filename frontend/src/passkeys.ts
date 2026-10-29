import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration, WebAuthnAbortService, WebAuthnError } from "@simplewebauthn/browser";
import { ApiError, api } from "./api";
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

// While the "Sign in with a passkey" button's request is open, autofill waits (only one passkey
// request can be open at a time; starting one cancels the other)
let buttonOpen = false;

export async function signInWithPasskey(autofill = false) {
  if (!autofill) buttonOpen = true;
  try {
    return await passkeyRequest(autofill);
  } finally {
    if (!autofill) buttonOpen = false;
  }
}

async function passkeyRequest(autofill: boolean) {
  const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("POST", "/api/auth/passkey/login/options", {});
  const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: autofill });
  return api<{ token: string; user: User }>("POST", "/api/auth/passkey/login/verify", { challengeId, response });
}

// Passkey autofill: as soon as the sign-in page opens, quietly ask the browser for a passkey.
// 1Password, iCloud Keychain, Google Password Manager... then offer it right away (on the
// username box, or in their own pop-up), with no button to press. The request is renewed every
// few minutes (the server forgets a challenge after 5). Returns a function that stops it.
export function startPasskeyAutofill(onSignedIn: (r: { token: string; user: User }) => void, onError: (message: string) => void) {
  let stopped = false;
  let renewing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<void> => {
    if (stopped || !(await browserSupportsWebAuthnAutofill())) return;
    if (buttonOpen) {
      setTimeout(() => void run(), 500);
      return;
    }
    renewing = false;
    timer = setTimeout(() => {
      renewing = true;
      WebAuthnAbortService.cancelCeremony(); // renewed below with a fresh challenge
    }, 4 * 60 * 1000);
    try {
      const r = await signInWithPasskey(true);
      if (!stopped) onSignedIn(r);
    } catch (e) {
      clearTimeout(timer);
      if (stopped) return;
      // Asked again only when it makes sense: we renewed it, the button's request took over
      // (it cancels this one), or the server turned a chosen passkey down (pick another).
      // The browser itself saying no means passkey autofill isn't available: stop.
      if (renewing || buttonOpen) return void run();
      if (e instanceof ApiError) {
        onError(e.message);
        setTimeout(() => void run(), 1500);
      }
    }
  };
  if (passkeysAvailable()) void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (!buttonOpen) WebAuthnAbortService.cancelCeremony();
  };
}

export async function addPasskey(name?: string) {
  const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("POST", "/api/auth/passkeys/register/options", {});
  const response = await startRegistration({ optionsJSON: options });
  return api<{ id: number; name: string; rpId: string }>("POST", "/api/auth/passkeys/register/verify", { challengeId, response, name: name?.trim() || undefined });
}
