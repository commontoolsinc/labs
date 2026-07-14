import env from "@/env.ts";
import { memoryWireAccountingAccumulator } from "@/routes/storage/memory.ts";
import { createMemoryWireAccountingRouter } from "./memory-wire-accounting-router.ts";

export { createMemoryWireAccountingRouter };

export default createMemoryWireAccountingRouter({
  accumulator: memoryWireAccountingAccumulator,
  token: env.CF_MEMORY_WIRE_ACCOUNTING_TOKEN,
  env: env.ENV,
});
