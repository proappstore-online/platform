/**
 * A software WebAuthn authenticator for the passkey tests (#230, #244): a P-256
 * key producing the exact bytes a browser would — clientDataJSON,
 * authenticatorData and a DER signature — for a given relying party.
 */
const enc = new TextEncoder();

export const b64url = (bytes: Uint8Array) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** Raw r||s → DER, as authenticators encode ES256 signatures. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    const v = x.slice(i);
    return v[0]! & 0x80 ? concat(new Uint8Array([0]), v) : v;
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length]), r, new Uint8Array([0x02, s.length]), s);
}

export class Authenticator {
  counter = 0;
  readonly credId = crypto.getRandomValues(new Uint8Array(16));
  private constructor(readonly keys: CryptoKeyPair, readonly rp: string) {}
  /** An authenticator for relying party `rp`; its ceremonies claim origin `https://${rp}` unless told otherwise. */
  static async create(rp: string) {
    return new Authenticator((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair, rp);
  }
  async authData(flags: number, withCredential: boolean) {
    const head = concat(await sha256(enc.encode(this.rp)), new Uint8Array([flags]), u32(this.counter));
    if (!withCredential) return head;
    return concat(head, new Uint8Array(16), new Uint8Array([0, this.credId.length]), this.credId);
  }
  async attest(challenge: string, o: { origin?: string } = {}) {
    const clientData = enc.encode(JSON.stringify({ type: 'webauthn.create', challenge, origin: o.origin ?? `https://${this.rp}` }));
    return {
      id: b64url(this.credId),
      clientDataJSON: b64url(clientData),
      authenticatorData: b64url(await this.authData(0x45, true)),
      publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey('spki', this.keys.publicKey) as ArrayBuffer)),
      publicKeyAlgorithm: -7,
    };
  }
  async assert(challenge: string, o: { flags?: number; signer?: CryptoKey; bumpCounter?: boolean; origin?: string } = {}) {
    if (o.bumpCounter !== false) this.counter++;
    const clientData = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: o.origin ?? `https://${this.rp}` }));
    const authData = await this.authData(o.flags ?? 0x05, false);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, o.signer ?? this.keys.privateKey, concat(authData, await sha256(clientData))));
    return { id: b64url(this.credId), clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(rawToDer(raw)) };
  }
}
