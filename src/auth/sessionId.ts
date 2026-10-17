export function getSessionIdFromToken(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof claims === "object"
      && claims !== null
      && "session_id" in claims
      && typeof claims.session_id === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.session_id)
    ) {
      return claims.session_id;
    }
  } catch {
    return null;
  }
  return null;
}
