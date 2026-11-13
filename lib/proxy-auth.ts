import { readUserStoreCached } from "./user-store";

/**
 * Proxy-layer authentication fast path.
 *
 * The Next.js proxy runs on the edge runtime and cannot await async scrypt
 * verification. Instead of duplicating the security decision, we do a cheap
 * structural check: well-formed Basic credentials for a known active username.
 * The authoritative scrypt check always happens in requireAuth() per route — a
 * pass here only avoids a double 401 round-trip.
 */
export function verifyUserCredentialsSyncHint(authorization: string | null): boolean {
  if (!authorization) return false;

  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!match) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep <= 0) return false;
  const username = decoded.slice(0, sep);
  const user = readUserStoreCached().users.find(
    (u) => u.username === username && u.status === "active",
  );
  return Boolean(user);
}
