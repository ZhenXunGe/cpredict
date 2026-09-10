import {
  createRemoteJWKSet,
  jwtVerify,
  errors,
  type JWTVerifyGetKey,
} from "jose";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import {
  AppError,
  type VerifiedIdentity,
} from "../../app-core/src/contracts.js";
import { fetchJson } from "./http.js";

export interface IdentityVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

/** Only Privy verifies identity. No app password, OAuth or key-management implementation. */
export class PrivyIdentityVerifier implements IdentityVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly userReader:
    | ((subject: string) => Promise<unknown>)
    | undefined;
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    dependencies?: {
      keys: JWTVerifyGetKey;
      readUser?: (subject: string) => Promise<unknown>;
    },
  ) {
    this.userReader = dependencies?.readUser;
    this.keys =
      dependencies?.keys ??
      createRemoteJWKSet(
        new URL(
          `https://api.privy.io/v1/apps/${encodeURIComponent(appId)}/jwks.json`,
        ),
        {
          timeoutDuration: 5_000,
          cooldownDuration: 30_000,
          cacheMaxAge: 600_000,
        },
      );
  }
  async verify(token: string): Promise<VerifiedIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        algorithms: ["ES256"],
        issuer: "privy.io",
        audience: this.appId,
        requiredClaims: ["exp", "iat", "sub", "sid"],
      });
      const parsedSubject = z
        .string()
        .startsWith("did:privy:")
        .max(160)
        .safeParse(payload.sub);
      if (
        !parsedSubject.success ||
        !z.string().min(1).max(256).safeParse(payload.sid).success
      )
        throw new AppError("unauthorized", 401);
      const subject = parsedSubject.data;
      if (
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number" ||
        payload.iat > Date.now() / 1000 + 60 ||
        payload.exp <= payload.iat
      )
        throw new AppError("unauthorized", 401);
      const user = z
        .object({
          id: z.string(),
          linked_accounts: z.array(z.record(z.string(), z.unknown())).max(200),
        })
        .parse(
          this.userReader
            ? await this.userReader(subject)
            : await fetchJson(
                `https://api.privy.io/v1/users/${encodeURIComponent(subject)}`,
                {
                  headers: {
                    authorization: `Basic ${Buffer.from(`${this.appId}:${this.appSecret}`).toString("base64")}`,
                    "privy-app-id": this.appId,
                  },
                  signal: AbortSignal.timeout(5_000),
                },
                262_144,
              ),
        );
      if (user.id !== subject) throw new AppError("identity_mismatch", 401);
      const controllers: VerifiedIdentity["controllers"][number][] = [];
      for (const link of user.linked_accounts) {
        if (
          link.type !== "wallet" ||
          link.chain_type !== "ethereum" ||
          typeof link.address !== "string" ||
          !isAddress(link.address) ||
          typeof link.verified_at !== "number" ||
          link.verified_at <= 0
        )
          continue;
        // Server delegation is not part of this product's wallet authority model.
        if ("delegated" in link && link.delegated) continue;
        controllers.push({
          address: getAddress(link.address),
          kind: link.wallet_client_type === "privy" ? "embedded" : "external",
        });
      }
      return { subject, controllers };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (
        error instanceof errors.JWTClaimValidationFailed ||
        error instanceof errors.JWTExpired ||
        error instanceof errors.JWSSignatureVerificationFailed ||
        error instanceof errors.JWSInvalid ||
        error instanceof errors.JWTInvalid ||
        error instanceof errors.JOSEAlgNotAllowed
      )
        throw new AppError("unauthorized", 401);
      throw new AppError("identity_service_unavailable", 503);
    }
  }
}
