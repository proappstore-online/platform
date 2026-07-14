// Session token verification. Re-exports the CANONICAL implementation from
// @proappstore/build-core (already a workspace dep). The previous local copy had
// drifted and was weaker — it accepted a token with no `exp` claim (`undefined <
// now` is false) and skipped the `uid` check. Keep a single audited verifier.
export { verifySession } from "@proappstore/build-core";
export type { SessionClaims as SessionPayload } from "@proappstore/build-core";
