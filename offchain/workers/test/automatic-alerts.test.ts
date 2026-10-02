import { describe, it, expect, vi, beforeEach } from "vitest";
import nodemailer from "nodemailer";
import { smtpDelivery, type AutomationAlert } from "../src/automatic-alerts.js";
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn() } }));
describe("automation SMTP configuration", () => {
  beforeEach(() => vi.clearAllMocks());
  it("blank recipient disables delivery regardless of other private settings", () => {
    expect(
      smtpDelivery({
        CPREDICT_AUTOMATION_ALERT_EMAIL_TO: " ",
        CPREDICT_AUTOMATION_SMTP_PASSWORD: "secret",
      }),
    ).toBeUndefined();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
  it("rejects incomplete private settings without exposing their values", () => {
    expect(() =>
      smtpDelivery({
        CPREDICT_AUTOMATION_ALERT_EMAIL_TO: "test@example.test",
        CPREDICT_AUTOMATION_SMTP_PASSWORD: "secret",
      }),
    ).toThrow("invalid_private_automation_email_configuration");
  });
  it("requires verified TLS and rejects an unaccepted message", async () => {
    const sendMail = vi.fn(async () => ({ accepted: [], rejected: ["a"] }));
    vi.mocked(nodemailer.createTransport).mockReturnValue({
      sendMail,
    } as never);
    const deliver = smtpDelivery({
      CPREDICT_AUTOMATION_ALERT_EMAIL_TO: "to@example.test",
      CPREDICT_AUTOMATION_ALERT_EMAIL_FROM: "from@example.test",
      CPREDICT_AUTOMATION_SMTP_HOST: "smtp.example.test",
      CPREDICT_AUTOMATION_SMTP_USER: "user",
      CPREDICT_AUTOMATION_SMTP_PASSWORD: "secret",
    });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 587,
        secure: false,
        requireTLS: true,
        tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    await expect(
      deliver!({
        id: "1",
        started_at: new Date(),
        event: "firing",
      } as AutomationAlert),
    ).rejects.toThrow("not_accepted");
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "<cpredict-automation-1@cpredict.local>",
      }),
    );
  });
});
