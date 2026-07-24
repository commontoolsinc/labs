// SHAPE 3c: the remedied form of shape 3 — the reactive selection hoisted to a
// body-level const, exactly as the `reactive:call-argument-computation`
// diagnostic advises (and as lunch-poll's participant-identity-card ships).
// Must compile clean.
import {
  type Cell,
  Default,
  handler,
  pattern,
  UI,
  Writable,
  wish,
} from "commonfabric";

interface Profile {
  name: string;
}

const join = handler<
  { name: string },
  {
    myName: Writable<string>;
    profile: Cell<Profile> | undefined;
  }
>((event, { myName, profile }) => {
  const resolved = profile?.get();
  myName.set(resolved ? resolved.name : event.name);
});

interface CardState {
  myName: Default<string, "">;
  profile?: Cell<Profile>;
}

export default pattern<CardState>(({ myName, profile }) => {
  const profileWish = wish<Profile>({ query: "#profile" });
  const activeProfile = profile ?? profileWish.result;
  const boundJoin = join({
    myName,
    profile: activeProfile,
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
