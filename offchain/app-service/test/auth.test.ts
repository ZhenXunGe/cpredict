import { describe, it, expect, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { PrivyIdentityVerifier } from "../src/auth.js";
import { A } from "../../app-core/test/fixtures.js";
describe("Privy identity cryptographic verification", () => {
  it("accepts only a correctly signed app token and verified non-delegated Ethereum controllers", async () => {
    const keys = await generateKeyPair("ES256"),
      subject = "did:privy:identity-test",
      readUser = vi.fn(async () => ({
        id: subject,
        linked_accounts: [
          {
            type: "wallet",
            chain_type: "ethereum",
            address: A(10),
            verified_at: 100,
            wallet_client_type: "privy",
          },
          {
            type: "wallet",
            chain_type: "ethereum",
            address: A(11),
            verified_at: 100,
            delegated: true,
          },
          {
            type: "wallet",
            chain_type: "ethereum",
            address: A(12),
            verified_at: null,
          },
          {
            type: "wallet",
            chain_type: "solana",
            address: "test",
            verified_at: 100,
          },
        ],
      }));
    const verifier = new PrivyIdentityVerifier("app-test", "unused", {
        keys: async () => keys.publicKey,
        readUser,
      }),
      token = await new SignJWT({ sid: "session-1" })
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer("privy.io")
        .setSubject(subject)
        .setAudience("app-test")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(keys.privateKey);
    expect(await verifier.verify(token)).toEqual({
      subject,
      controllers: [{ address: A(10), kind: "embedded" }],
    });
    expect(readUser).toHaveBeenCalledWith(subject);
  });
  it("rejects wrong app, issuer, expired tokens and forged signatures before reading linked accounts", async () => {
    const keys = await generateKeyPair("ES256"),
      other = await generateKeyPair("ES256"),
      readUser = vi.fn(),
      verifier = new PrivyIdentityVerifier("expected", "unused", {
        keys: async () => keys.publicKey,
        readUser,
      });
    for (const scenario of ["audience", "issuer", "expired", "signature"]) {
      let jwt = new SignJWT({ sid: "s" })
        .setProtectedHeader({ alg: "ES256" })
        .setSubject("did:privy:test")
        .setIssuedAt()
        .setAudience(scenario === "audience" ? "other" : "expected")
        .setIssuer(scenario === "issuer" ? "other" : "privy.io")
        .setExpirationTime(scenario === "expired" ? 1 : "1h");
      const token = await jwt.sign(
        scenario === "signature" ? other.privateKey : keys.privateKey,
      );
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: "unauthorized",
        status: 401,
      });
    }
    expect(readUser).not.toHaveBeenCalled();
  });
  it("fails closed when official user lookup is unavailable or contradicts the authenticated subject", async () => {
    const keys = await generateKeyPair("ES256"),
      token = await new SignJWT({ sid: "s" })
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer("privy.io")
        .setAudience("app")
        .setSubject("did:privy:test")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(keys.privateKey);
    const missing = new PrivyIdentityVerifier("app", "unused", {
      keys: async () => keys.publicKey,
      readUser: async () => {
        throw new Error("upstream text must not escape");
      },
    });
    await expect(missing.verify(token)).rejects.toMatchObject({
      code: "identity_service_unavailable",
      status: 503,
    });
    const mismatch = new PrivyIdentityVerifier("app", "unused", {
      keys: async () => keys.publicKey,
      readUser: async () => ({ id: "different", linked_accounts: [] }),
    });
    await expect(mismatch.verify(token)).rejects.toMatchObject({
      code: "identity_mismatch",
      status: 401,
    });
  });
});
