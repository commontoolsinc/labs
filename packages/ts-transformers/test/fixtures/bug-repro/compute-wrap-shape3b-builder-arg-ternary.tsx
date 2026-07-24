// Builder-arg computation variants: a ternary (`label:`) and a comparison
// (`isFirst:`) in bound-handler builder args. The ternary lowers via the
// conditional emitter's ifElse path; the comparison hits the compute-wrap
// guard and must produce the `reactive:call-argument-computation` hoist
// diagnostic (it used to crash the compiler) under
// `deno task cf check <this file> --no-run`.
import {
  Default,
  handler,
  pattern,
  UI,
  Writable,
} from "commonfabric";

const join = handler<
  { name: string },
  {
    myName: Writable<string>;
    label: string;
    isFirst: boolean;
  }
>((event, { myName }) => {
  myName.set(event.name);
});

interface CardState {
  myName: Default<string, "">;
  users: Default<string[], []>;
}

export default pattern<CardState>(({ myName, users }) => {
  const boundJoin = join({
    myName,
    label: users.length > 0 ? "join the others" : "be first",
    isFirst: users.length === 0,
  });
  return {
    [UI]: (
      <div>
        <cf-button onClick={() => boundJoin.send({ name: "guest" })}>
          Join
        </cf-button>
      </div>
    ),
  };
});
