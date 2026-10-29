import crypto from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

// A software passkey for tests: does what Touch ID / a phone does in the browser
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest();

export function softPasskey(opts: { synced?: boolean } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credId = crypto.randomBytes(16);
  let counter = 0;
  const flags = 0x01 | 0x04 | (opts.synced ? 0x08 | 0x10 : 0); // user present, verified, (backup eligible + backed up)

  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  const authData = (rpId: string, withCred: boolean) => {
    const parts = [sha256(rpId), Buffer.from([flags | (withCred ? 0x40 : 0)]), Buffer.alloc(4)];
    parts[2].writeUInt32BE(counter);
    if (withCred) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length);
      parts.push(Buffer.alloc(16), len, credId, Buffer.from(cose));
    }
    return Buffer.concat(parts);
  };

  return {
    id: b64u(credId),
    // navigator.credentials.create()
    create(options: { challenge: string; rp: { id: string } }, origin: string) {
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
      const attestation = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(options.rp.id, true)]]) as never);
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestation), transports: ["internal"] } };
    },
    // navigator.credentials.get()
    get(options: { challenge: string; rpId: string }, origin: string, signAs?: string) {
      counter++;
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
      const ad = authData(signAs ?? options.rpId, false);
      const signature = crypto.sign("sha256", Buffer.concat([ad, sha256(clientData)]), privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(ad), signature: b64u(signature), userHandle: b64u(Buffer.from("zsb-user-1")) } };
    },
  };
}
