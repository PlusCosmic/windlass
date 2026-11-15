import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "windlass_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** A signed cookie value naming who is signed in and until when. There is no server-side session to revoke. */
export function createSession(secret: string, login: string, now: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ login, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS })).toString(
    "base64url",
  );
  return `${payload}.${sign(secret, payload)}`;
}

/** The login in a session cookie, or null when it's missing, forged or expired. */
export function readSession(secret: string, cookie: string | undefined, now: number = Date.now()): string | null {
  if (!cookie) return null;
  const [payload, signature, ...rest] = cookie.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data !== "object" || data === null) return null;
    const { login, exp } = data as { login?: unknown; exp?: unknown };
    if (typeof login !== "string" || typeof exp !== "number" || exp * 1000 <= now) return null;
    return login;
  } catch {
    return null;
  }
}
