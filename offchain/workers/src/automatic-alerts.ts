import nodemailer from "nodemailer";
import { z } from "zod";
import type { PostgresAutomaticStore } from "./automatic-store.js";

export interface AutomationAlert {
  id: string;
  transaction_id: string;
  tx_hash: string;
  chain_id: string;
  deployment_id: string;
  lane: string;
  signer: string;
  nonce: string;
  event: "firing" | "resolved";
  started_at: Date;
  attempts: number;
}
export type AlertDelivery = (alert: AutomationAlert) => Promise<void>;

/** Recipient unset means disabled, never a pretend successful delivery. */
export function smtpDelivery(
  env: NodeJS.ProcessEnv,
): AlertDelivery | undefined {
  if (!env.CPREDICT_AUTOMATION_ALERT_EMAIL_TO?.trim()) return undefined;
  let cfg: {
    to: string;
    from: string;
    host: string;
    port: number;
    user: string;
    pass: string;
  };
  try {
    cfg = z
      .object({
        to: z.email(),
        from: z.email(),
        host: z.string().regex(/^[a-z0-9.-]+$/i),
        port: z.coerce.number().refine((p) => p === 465 || p === 587),
        user: z.string().min(1),
        pass: z.string().min(1),
      })
      .parse({
        to: env.CPREDICT_AUTOMATION_ALERT_EMAIL_TO,
        from: env.CPREDICT_AUTOMATION_ALERT_EMAIL_FROM,
        host: env.CPREDICT_AUTOMATION_SMTP_HOST,
        port: env.CPREDICT_AUTOMATION_SMTP_PORT ?? 587,
        user: env.CPREDICT_AUTOMATION_SMTP_USER,
        pass: env.CPREDICT_AUTOMATION_SMTP_PASSWORD,
      });
  } catch {
    throw new Error("invalid_private_automation_email_configuration");
  }
  const mail = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    requireTLS: true,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
    dnsTimeout: 5000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return async (a) => {
    const result = await mail.sendMail({
      from: cfg.from,
      to: cfg.to,
      messageId: `<cpredict-automation-${a.id}@cpredict.local>`,
      subject:
        a.event === "firing"
          ? "Cpredict：自动领取/撮合等待超过两分钟"
          : "Cpredict：自动化卡单已完成对账",
      text: [
        `状态：${a.event}`,
        `链：${a.chain_id}`,
        `部署：${a.deployment_id}`,
        `通道：${a.lane}`,
        `发送账户：${a.signer}`,
        `nonce：${a.nonce}`,
        `原交易：${a.tx_hash}`,
        `开始时间：${a.started_at.toISOString()}`,
        "请查询持久交易与替换记录。不要删除 unknown 记录或使用新 nonce 重发。",
      ].join("\n"),
    });
    if (result.rejected.length || !result.accepted.length)
      throw new Error("automation_email_not_accepted");
  };
}

/** Durable, leased outbox. SMTP timeouts may duplicate notifications, never chain
 * transactions. Stable Message-ID gives receivers a deduplication key. */
export class AutomationAlerts {
  constructor(
    readonly store: PostgresAutomaticStore,
    readonly deliver?: AlertDelivery,
  ) {}
  async sync(): Promise<number> {
    await this.store.sql.begin(async (db) => {
      await db`INSERT INTO automation_alert_events(transaction_id,tx_hash,chain_id,deployment_id,lane,signer,nonce,event,started_at)
        SELECT t.id,t.tx_hash,t.chain_id,t.deployment_id,${this.store.lane},t.signer,t.nonce,'firing',COALESCE(t.first_broadcast_at,t.broadcast_at,t.created_at)
        FROM automation_transactions t WHERE t.chain_id=${this.store.chainId} AND t.deployment_id=${this.store.deploymentId} AND t.signer=${this.store.signer.toLowerCase()}
        AND t.state IN ('prepared','broadcasting','unknown') AND COALESCE(t.first_broadcast_at,t.broadcast_at,t.created_at)<=now()-interval '2 minutes'
        AND NOT EXISTS(SELECT 1 FROM automation_alert_events a WHERE a.transaction_id=t.id AND a.event='firing')
        ON CONFLICT(transaction_id,tx_hash,event) DO NOTHING`;
      await db`INSERT INTO automation_alert_events(transaction_id,tx_hash,chain_id,deployment_id,lane,signer,nonce,event,started_at)
        SELECT a.transaction_id,a.tx_hash,a.chain_id,a.deployment_id,a.lane,a.signer,a.nonce,'resolved',a.started_at FROM automation_alert_events a
        JOIN automation_transactions t ON t.id=a.transaction_id WHERE a.chain_id=${this.store.chainId} AND a.deployment_id=${this.store.deploymentId} AND a.signer=${this.store.signer.toLowerCase()}
        AND a.event='firing' AND t.state NOT IN ('prepared','broadcasting','unknown') ON CONFLICT(transaction_id,tx_hash,event) DO NOTHING`;
    });
    const [r] = await this.store
      .sql`SELECT count(*)::int AS count FROM automation_alert_events WHERE chain_id=${this.store.chainId} AND deployment_id=${this.store.deploymentId} AND signer=${this.store.signer.toLowerCase()} AND sent_at IS NULL`;
    return r?.count ?? 0;
  }
  async sendOne(): Promise<"disabled" | "idle" | "sent" | "failed"> {
    if (!this.deliver) return "disabled";
    const [a] = await this.store.sql<
      AutomationAlert[]
    >`UPDATE automation_alert_events SET attempts=attempts+1,lease_until=now()+interval '90 seconds'
      WHERE id=(SELECT a.id FROM automation_alert_events a WHERE chain_id=${this.store.chainId} AND deployment_id=${this.store.deploymentId} AND signer=${this.store.signer.toLowerCase()}
      AND sent_at IS NULL AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now())
      AND (event='firing' OR EXISTS(SELECT 1 FROM automation_alert_events f WHERE f.transaction_id=a.transaction_id AND f.tx_hash=a.tx_hash AND f.event='firing' AND f.sent_at IS NOT NULL))
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id::text,transaction_id::text,tx_hash,chain_id::text,deployment_id,lane,signer,nonce::text,event,started_at,attempts`;
    if (!a) return "idle";
    try {
      await this.deliver(a);
      await this.store
        .sql`UPDATE automation_alert_events SET sent_at=now(),lease_until=NULL,last_failure=NULL WHERE id=${a.id} AND attempts=${a.attempts}`;
      return "sent";
    } catch {
      const wait = Math.min(3600, 60 * 2 ** Math.min(a.attempts - 1, 6));
      await this.store
        .sql`UPDATE automation_alert_events SET lease_until=NULL,last_failure='delivery_failed',next_attempt_at=now()+${wait}*interval '1 second' WHERE id=${a.id} AND attempts=${a.attempts}`;
      return "failed";
    }
  }
}
