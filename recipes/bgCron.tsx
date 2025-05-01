import { h } from "@commontools/html";
import {
  cell,
  derive,
  handler,
  JSONSchema,
  NAME,
  recipe,
  schema,
  str,
  UI,
} from "@commontools/builder";

/* -------------------------------------------------------- */
/* 1. Schemas                                               */
/* -------------------------------------------------------- */

const updaterSchema = {
  type: "object",
  properties: {
    delta: { type: "number", default: 1 },
  },
  title: "Update Count (cron-aware)",
  description: "Increase the count when the cron pattern matches.",
} as const satisfies JSONSchema;

const inputSchema = schema({
  type: "object",
  properties: {
    pattern: {
      type: "string",
      default: "* * * * *", // every minute
      description:
        "Cron pattern (min hour dom mon dow).  Only *, n, n-m, a,b,c and */n supported.",
    },
    count: { type: "number", default: 0 },
    status: { type: "string", default: "" },
  },
});

const outputSchema = {
  type: "object",
  properties: {
    count: { type: "number" },
    bgUpdater: {
      asStream: true,
      ...updaterSchema,
    },
  },
} as const satisfies JSONSchema;

/* -------------------------------------------------------- */
/* 2. Tiny cron matcher                                     */
/* -------------------------------------------------------- */

function matchField(field: string, value: number): boolean {
  // split possible list: "5,10,*/15"
  return field.split(",").some((token) => {
    token = token.trim();
    if (token === "*") return true;

    // */n  ------------------------------------------------------------------
    if (token.startsWith("*/")) {
      const step = Number(token.slice(2));
      return step > 0 && value % step === 0;
    }

    // n-m  ------------------------------------------------------------------
    if (token.includes("-")) {
      const [from, to] = token.split("-").map(Number);
      return value >= from && value <= to;
    }

    // plain number ----------------------------------------------------------
    const num = Number(token);
    return !isNaN(num) && value === num;
  });
}

function shouldTrigger(pattern: string, date: Date): boolean {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) {
    console.error("Malformed cron pattern:", pattern);
    console.log("the pattern should be like this: */5 * * * *");
    return false; // malformed pattern
  }

  const [min, hr, dom, mon, dow] = parts;

  return (
    matchField(min, date.getMinutes()) &&
    matchField(hr, date.getHours()) &&
    matchField(dom, date.getDate()) &&
    matchField(mon, date.getMonth() + 1) && // JS months 0-11
    matchField(dow, date.getDay())
  );
}

/* -------------------------------------------------------- */
/* 3. Handlers                                              */
/* -------------------------------------------------------- */

/* Called automatically every minute by the platform. */
const updater = handler<
  { nothing?: boolean },
  { count: number; pattern: string }
>((_, state) => {
  if (shouldTrigger(state.pattern, new Date())) {
    state.count = (state.count ?? 0) + 1;
  }
});

/* Live editing of the cron pattern from the UI. */
const updatePattern = handler<
  { detail: { value: string } },
  { pattern: string; status: string }
>(({ detail }, state) => {
  if (detail?.value) {
    if (detail.value.split(" ").length !== 5) {
      state.status = "Malformed cron pattern";
    } else {
      state.pattern = detail?.value ?? "* * * * *";
      state.status = "Cron pattern updated";
    }
  }
});

/* -------------------------------------------------------- */
/* 4. Recipe                                                */
/* -------------------------------------------------------- */

export default recipe(
  inputSchema,
  outputSchema,
  ({ count, pattern, status }) => {
    /* log for demonstration only */
    derive(count, (c) => console.log("count#", c));

    return {
      [NAME]: str`Cron: ${derive(count, (c) => c)}`,

      [UI]: (
        <div>
          <p>
            Background updater runs each minute and compares the current time to
            the cron pattern below. If it matches, the count increments.
          </p>
          <p>
            The pattern is: Minutes Hours Day-of-Month Month Day-of-Week
            <br />
            <br />
            Example: */5 * * * *
            <br />
            <br />
            This will increment the count every 5 minutes.
          </p>

          <common-input
            value={pattern}
            placeholder="Cron pattern (e.g. */5 * * * *)"
            oncommon-input={updatePattern({ pattern, status })}
          />
          <p>{status}</p>

          <common-updater $state={count} integration="cron" />

          <div>{count}</div>
        </div>
      ),

      /* background stream called every minute by the platform */
      bgUpdater: updater({ count, pattern }),
      count,
    };
  },
);
