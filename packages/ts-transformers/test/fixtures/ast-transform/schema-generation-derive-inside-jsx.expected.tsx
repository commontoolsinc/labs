/// <cts-enable />
import { derive, h } from "commontools";
declare const value: number;
// This derive is INSIDE JSX and should NOT be transformed with schemas
// (JSX expressions are handled by the jsx-expression transformer instead)
export const result = (<div>
    {derive(value, (v) => v * 2)}
  </div>);