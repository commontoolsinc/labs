import { NAME, pattern, UI } from "commonfabric";
import type { DebugInput } from "../../../patterns/agent-sessions-debug/main.tsx";

export default pattern<DebugInput>((_) => ({
  [NAME]: "Alternate agent sessions",
  [UI]: <cf-screen>Alternate agent sessions</cf-screen>,
}));
