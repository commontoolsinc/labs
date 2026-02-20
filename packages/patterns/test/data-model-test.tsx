/// <cts-enable />
import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

const VERSION = "v26";

function describeValue(val: any): string {
  const type = typeof val;
  let repr: string;
  if (val === undefined) repr = "undefined";
  else if (val === null) repr = "null";
  else if (val !== val) repr = "NaN";
  else if (val === Infinity) repr = "Infinity";
  else if (val === -Infinity) repr = "-Infinity";
  else {
    try {
      repr = JSON.stringify(val, null, 2);
    } catch {
      repr = String(val);
    }
  }
  return `typeof: ${type}\n\nvalue:  ${repr}`;
}

function nowTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${
    pad(d.getHours())
  }:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface Input {
  value?: Writable<Default<any, null>>;
  inputText?: Writable<Default<string, "">>;
  errorMsg?: Writable<Default<string, "">>;
  evalTime?: Writable<Default<string, "(never)">>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  value: any;
  evalAndStore: Stream<void>;
  rerenderDisplay: Stream<void>;
}

const evalAndStore = handler<
  void,
  {
    value: Writable<any>;
    inputText: Writable<string>;
    errorMsg: Writable<string>;
    evalTime: Writable<string>;
  }
>((_, { value, inputText, errorMsg, evalTime }) => {
  const expr = inputText.get();
  console.log(`[data-model-test] evaluating: ${expr}`);
  try {
    // Intentional use of `new Function` for testing: This pattern exists to
    // exercise the data model's serialization of arbitrary JS values. Patterns
    // run inside the sandboxed piece runtime, not the host.
    const result = new Function(`return (${expr})`)();
    console.log(`[data-model-test] result:`, result);
    value.set(result);
    errorMsg.set("");
    evalTime.set(nowTimestamp());
  } catch (e: any) {
    console.log(`[data-model-test] error:`, e);
    errorMsg.set(String(e));
  }
});

const rerenderDisplay = handler<
  void,
  { value: Writable<any>; evalTime: Writable<string> }
>(
  (_, { value, evalTime }) => {
    const v = value.get();
    console.log(`[data-model-test] rerender from stored value:`, v);
    evalTime.set(nowTimestamp());
  },
);

export default pattern<Input, Output>(
  ({ value, inputText, errorMsg, evalTime }) => {
    console.log(`[data-model-test] loaded ${VERSION}`);

    const boundEvalAndStore = evalAndStore({
      value,
      inputText,
      errorMsg,
      evalTime,
    });
    const boundRerenderDisplay = rerenderDisplay({ value, evalTime });

    const display = computed(() => {
      const ts = evalTime.get();
      const desc = describeValue(value.get());
      return `evaluated at: ${ts}\n${desc}`;
    });

    return {
      [NAME]: "Data Model Test",
      [UI]: (
        <ct-vstack gap={1} style="padding: 1rem; max-width: 500px;">
          <h3>Data Model Test</h3>
          <ct-textarea
            $value={inputText}
            placeholder='JS expression, e.g. 42, "hello", undefined, {a: [1,2]}'
          />
          <ct-button onClick={boundEvalAndStore}>Evaluate & Store</ct-button>
          <ct-button onClick={boundRerenderDisplay}>Rerender Display</ct-button>
          <pre
            style={{
              padding: "12px",
              backgroundColor: "#f3f4f6",
              borderRadius: "8px",
              whiteSpace: "pre-wrap",
              minHeight: "60px",
              fontFamily: "monospace",
            }}
          >
          {display}
          </pre>
          <div style={{ color: "red", fontSize: "0.875rem" }}>{errorMsg}</div>
          <div style={{ color: "grey", fontSize: "9pt" }}>{VERSION}</div>
        </ct-vstack>
      ),
      value,
      evalAndStore: boundEvalAndStore,
      rerenderDisplay: boundRerenderDisplay,
    };
  },
);
