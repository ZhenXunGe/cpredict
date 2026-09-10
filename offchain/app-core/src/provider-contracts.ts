import { z } from "zod";

export const managementEndpointSchema = z.enum([
  "statistics",
  "policies",
  "webhooks",
  "team-spend",
]);
export const managementWindowSchema = z.strictObject({
  start: z.string().datetime(),
  end: z.string().datetime(),
});
export const managementStatusSchema = z.strictObject({
  provider: z.literal("zerodev"),
  source: z.literal("https://public-api.zerodev.app"),
  projectId: z.string(),
  chainId: z.literal(421614),
  pollingSeconds: z.literal(300),
  staleAfterSeconds: z.literal(900),
  mappingStatus: z.literal("awaiting-real-response-contract"),
  endpoints: z.array(
    z.strictObject({
      endpoint: managementEndpointSchema,
      lastAttemptAt: z.string().datetime().nullable(),
      lastSuccessAt: z.string().datetime().nullable(),
      requestedWindow: managementWindowSchema.nullable(),
      dataWindow: managementWindowSchema.nullable(),
      error: z
        .enum([
          "unauthorized",
          "forbidden",
          "rate-limited",
          "provider-error",
          "timeout",
          "unavailable",
          "invalid-response",
        ])
        .nullable(),
      stale: z.boolean(),
    }),
  ),
});
export type ManagementStatus = z.infer<typeof managementStatusSchema>;
