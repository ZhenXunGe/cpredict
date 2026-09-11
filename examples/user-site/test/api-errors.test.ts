import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { env, operation } from "../../../offchain/app-core/test/fixtures.js";
import { SiteApi, ServiceResponseError, errorCopy } from "../src/api.js";
import { rulesPublicationErrorCopy } from "../src/metadata.js";

afterEach(() => vi.unstubAllGlobals());
async function failure(
  body: string,
  status: number,
  service: "app" | "metadata" = "metadata",
  contentType = "application/json",
) {
  vi.stubGlobal("window", { location: { origin: "https://test.example" } });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(body, {
          status,
          headers: { "content-type": contentType },
        }),
      ),
  );
  try {
    await new SiteApi(env).request(
      "/v1/challenges",
      z.object({ ok: z.boolean() }),
      { service, body: {} },
    );
    throw new Error("expected request failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceResponseError);
    return error as ServiceResponseError;
  }
}

describe("service error envelopes and rules publication copy", () => {
  it.each([
    [400, "invalid challenge request", "invalid_factory", "Factory"],
    [409, "challenge unavailable", "challenge_unavailable", "已过期或已使用"],
    [409, "challenge expired", "challenge_expired", "挑战已过期"],
    [401, "invalid signature", "invalid_signature", "签名无效"],
    [
      503,
      "signature verification unavailable",
      "signature_verification_unavailable",
      "无法验证规则签名",
    ],
    [500, "internal error", "metadata_internal_error", "规则服务内部错误"],
  ])(
    "preserves metadata HTTP %s and %s",
    async (status, message, code, copy) => {
      const body = JSON.stringify({ error: message });
      const error = await failure(body, status);
      expect(error).toMatchObject({
        code,
        status,
        message,
        responseBody: body,
      });
      const text = rulesPublicationErrorCopy(error);
      expect(text).toContain(copy);
      expect(text).toContain(`HTTP ${status}`);
      expect(text).toContain(message);
      expect(text).toContain("尚未提交链上创建交易");
      expect(text).not.toMatch(
        /service_unavailable|rules_publication_failed|操作编号|恢复入口/,
      );
    },
  );
  it("reads app code, message and an actual operation ID", async () => {
    const error = await failure(
      JSON.stringify({
        error: {
          code: "provider_policy_rejected",
          message: "provider operation limit exceeded",
          operationId: operation.id,
        },
      }),
      403,
      "app",
    );
    expect(error).toMatchObject({
      code: "provider_policy_rejected",
      message: "provider operation limit exceeded",
      operationId: operation.id,
      status: 403,
    });
    expect(errorCopy(error)).toContain(operation.id);
    expect(errorCopy(error)).toContain("provider operation limit exceeded");
  });
  it("retains structured metadata reason and service request ID without inventing an operation", async () => {
    const error = await failure(
      JSON.stringify({
        error: "metadata signature storage is incompatible",
        code: "metadata_storage_incompatible",
        requestId: "req-he",
      }),
      500,
    );
    expect(errorCopy(error)).toContain("签名存储格式不兼容");
    expect(errorCopy(error)).toContain("req-he");
    expect(error.operationId).toBeUndefined();
  });
  it.each([
    [502, "<html><h1>Bad Gateway</h1></html>", "text/html", "Bad Gateway"],
    [401, "Unauthorized", "text/plain", "Unauthorized"],
    [
      503,
      '{"message":"upstream timeout"}',
      "application/json",
      "upstream timeout",
    ],
    [200, '{"unexpected":true}', "application/json", "unexpected"],
  ])(
    "retains HTTP %s and bounded diagnostics for nonstandard responses",
    async (status, body, contentType, detail) => {
      const error = await failure(body, status, "metadata", contentType);
      expect(error.status).toBe(status);
      expect(error.contentType).toBe(contentType);
      expect(error.responseBody).toContain(detail);
      expect(rulesPublicationErrorCopy(error)).toContain(detail);
      expect(rulesPublicationErrorCopy(error)).not.toContain("操作编号");
    },
  );
  it("redacts credentials and signed data from diagnostic copy", async () => {
    const signedPayload = `0x${"ab".repeat(512)}`;
    const error = await failure(
      JSON.stringify({
        error: `signature=${signedPayload} password=private-test-value Bearer private-test-token`,
      }),
      500,
    );
    for (const value of [errorCopy(error), error.responseBody]) {
      expect(value).not.toContain(signedPayload);
      expect(value).not.toContain("private-test-value");
      expect(value).not.toContain("private-test-token");
    }
  });
});
