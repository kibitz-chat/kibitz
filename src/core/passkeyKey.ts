// Derive a room memory key (`mk`) from a PASSKEY via the WebAuthn `prf` extension (docs/encrypted-memory.md — an
// alternative to a link-carried `mk`). The passkey's private key never leaves the authenticator (secure enclave /
// synced via the platform); `prf` deterministically derives a stable, high-entropy secret from (passkey, salt), so
// `mk` is RE-DERIVED on demand and never stored anywhere — phishing-resistant, nothing-at-rest. The control link
// then carries only the non-secret `salt` + credential id (`mksrc=pk&mksalt=…&mkcid=…`), not `mk`.
//
// STATUS: self-contained + capability-gated; NOT yet wired into the wizard / call flow. The ceremonies below need
// ON-DEVICE verification (a real authenticator + user verification) — `prf`/hmac-secret support is uneven and can't
// be validated headless. Until wired+verified, rooms use the random-`mk` control-link path. The PURE part
// (prfSecretToMemKey) is unit-tested so the crypto contract — `mk = base64url(first 32 prf bytes)` — is locked.

const toB64url = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromB64url = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

/** Plausibly able to run a passkey ceremony here? (Actual `prf` support is only known after a ceremony.) */
export function passkeySupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && typeof navigator !== 'undefined' && typeof navigator.credentials?.create === 'function'
}

/** The room key from a `prf` secret: base64url of the first 32 bytes (the secret is already uniform high-entropy).
 *  PURE + deterministic — same passkey + same salt → same `mk` → matches the summon's commitment. */
export function prfSecretToMemKey(secret: ArrayBuffer | Uint8Array): string {
  const u = secret instanceof Uint8Array ? secret : new Uint8Array(secret)
  return toB64url(u.slice(0, 32))
}

const RP_NAME = 'kibitz'

// Run a `get` assertion that evaluates the prf for an existing credential; returns the first prf output (or undefined).
async function evalPrf(credId: ArrayBuffer, salt: Uint8Array, rpId?: string): Promise<ArrayBuffer | undefined> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: credId }],
      ...(rpId ? { rpId } : {}),
      userVerification: 'preferred',
      // prf is a WebAuthn L3 extension; the lib DOM types may not include it yet → cast.
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  const results = (assertion?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined)?.prf?.results
  return results?.first
}

/** Enroll a NEW passkey for this room and derive `mk` via prf. Returns { mk, salt, credId } — put salt+credId
 *  (non-secret) in the control link so `mk` can be re-derived later. Throws if cancelled / prf unsupported.
 *  ⚠️ Needs on-device verification (a real authenticator). */
export async function enrollMemKeyPasskey(opts: { rpId?: string; userName?: string } = {}): Promise<{ mk: string; salt: string; credId: string }> {
  if (!passkeySupported()) throw new Error('passkeys unsupported here')
  const salt = crypto.getRandomValues(new Uint8Array(32))
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: RP_NAME, ...(opts.rpId ? { id: opts.rpId } : {}) },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: opts.userName || 'room', displayName: opts.userName || 'room' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('passkey creation cancelled')
  // Some authenticators return prf at create-time; others require a follow-up get to evaluate it.
  const created = (cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first
  const secret = created || (await evalPrf(cred.rawId, salt, opts.rpId))
  if (!secret) throw new Error('this passkey / browser does not support the prf extension')
  return { mk: prfSecretToMemKey(secret), salt: toB64url(salt), credId: toB64url(new Uint8Array(cred.rawId)) }
}

/** Re-derive `mk` from an EXISTING passkey using the salt + credential id from the control link.
 *  ⚠️ Needs on-device verification (a real authenticator). */
export async function deriveMemKeyPasskey(saltB64: string, credIdB64: string, rpId?: string): Promise<string> {
  if (!passkeySupported()) throw new Error('passkeys unsupported here')
  const secret = await evalPrf(fromB64url(credIdB64).buffer as ArrayBuffer, fromB64url(saltB64), rpId)
  if (!secret) throw new Error('prf derivation failed (passkey not found / prf unsupported)')
  return prfSecretToMemKey(secret)
}
