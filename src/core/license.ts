/**
 * The premium license key, if the user has one. Stored locally and sent on
 * premium API calls (e.g. /api/turn) so the server can check entitlement —
 * gating is enforced server-side, never here (this file is public).
 *
 * No key → free tier (the default for everyone today). The upgrade UI that
 * *sets* this isn't built yet: premium is scaffolded and dormant, so for now a
 * key only exists if one is set manually (e.g. localStorage `kbz_license`).
 */
const STORAGE_KEY = 'kbz_license'

export function getLicenseKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setLicenseKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable — premium just stays off */
  }
}
