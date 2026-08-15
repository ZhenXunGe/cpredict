import { Counter, Registry } from "prom-client";
import type { Address } from "viem";
import type {
  MaintenanceResult,
  TerminalWorkerTelemetry,
} from "./terminal-workers.js";

export class PrometheusTerminalWorkerTelemetry implements TerminalWorkerTelemetry {
  readonly registry: Registry;
  private readonly operations: Counter<"operation" | "outcome">;
  private readonly unexpectedErrors: Counter;

  constructor(registry = new Registry()) {
    this.registry = registry;
    this.operations = new Counter({
      name: "cpredict_terminal_worker_operations_total",
      help: "Permissionless maintenance operation outcomes",
      labelNames: ["operation", "outcome"],
      registers: [registry],
    });
    this.unexpectedErrors = new Counter({
      name: "cpredict_terminal_worker_unexpected_errors_total",
      help: "Unexpected terminal worker failures",
      registers: [registry],
    });
  }

  record(result: MaintenanceResult): void {
    this.operations.inc({
      operation: result.operation,
      outcome: result.outcome,
    });
  }

  unexpected(_error: unknown, _market?: Address): void {
    this.unexpectedErrors.inc();
  }
}
