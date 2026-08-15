// Backward-compatible executable alias. It intentionally starts the complete production runtime;
// there is no weaker API-only path with a second environment-variable contract.
import { runIndexerServiceProcess } from "./main.js";

await runIndexerServiceProcess();
