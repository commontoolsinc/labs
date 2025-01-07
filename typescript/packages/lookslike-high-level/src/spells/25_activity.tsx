import {
  h,
  Session,
  refer,
} from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { Charm, initRules, typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { Reference } from "merkle-reference";
import { importEntity, resolve, tagWithSchema } from "../sugar/sugar.jsx";
import { Ref, UiFragment } from "../sugar/zod.js";
import { log, LogEntry } from "../sugar/activity.js";

const ActivityLog = z.object({
  log: z.array(LogEntry).describe('The log of activities')
})

export const activity = typedBehavior(
  ActivityLog.pick({
    log: true
  }), {
  render: ({ self, log }) => {
    return (
      <table entity={self} title="Activity Log" style="width: 100%; border-spacing: 0">
        <tbody>
          {[...log].filter(entry => !isNaN(new Date(entry.modified).getTime())).sort((a, b) => Number(new Date(b.modified)) - Number(new Date(a.modified))).map((entry, i) => (
            <tr style={`margin-bottom: 8px; background: ${i % 2 === 0 ? '#fff' : '#f5f5f5'}; border-bottom: 1px solid #eee`}>
              <td style="font-size: 10px; white-space: nowrap; padding: 8px 16px 8px 0">
                {new Date(entry.modified).toLocaleString()}
              </td>
              <td style="padding: 8px 0">{entry.message}</td>
              <td style="text-align: right; padding: 8px 0">
                <code style="background: #eee; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-family: monospace">
                  {entry.target?.toString()}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  },
  rules: schema => ({
    init: initRules.init,
  }),
});
