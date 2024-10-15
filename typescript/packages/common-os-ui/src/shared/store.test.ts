import { createStore, cursor, unknown } from "./store.js";
import * as assert from "node:assert/strict";

describe("createStore", () => {
  type State = { count: number };
  type Msg = { type: "increment" } | { type: "decrement" };

  const init = (): State => ({ count: 0 });

  const update = (state: State, msg: Msg): State => {
    switch (msg.type) {
      case "increment":
        return { ...state, count: state.count + 1 };
      case "decrement":
        return { ...state, count: state.count - 1 };
      default:
        return state;
    }
  };

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("should initialize with the correct state", () => {
    const state = init();
    const store = createStore({
      state,
      update,
    });
    assert.deepEqual(store.get(), state);
  });

  it("should update state when sending a message", () => {
    const state = init();
    const store = createStore({
      state,
      update,
    });

    store.send({ type: "increment" });
    assert.deepEqual(store.get(), { count: 1 });

    store.send({ type: "decrement" });
    assert.deepEqual(store.get(), { count: 0 });
  });

  it("should notify listeners when state changes", (done) => {
    const initialState = init();
    const store = createStore({
      state: initialState,
      update,
    });

    let callCount = 0;

    const cleanup = store.sink((state) => {
      callCount++;
      if (callCount === 1) {
        assert.deepEqual(state, initialState);
      } else if (callCount === 2) {
        assert.deepEqual(state, { count: 1 });
        cleanup();
        done();
      }
    });

    store.send({ type: "increment" });
  });

  it("should not notify listeners after cleanup", () => {
    const initialState = init();
    const store = createStore({
      state: initialState,
      update,
    });

    let callCount = 0;
    const cleanup = store.sink(() => {
      callCount++;
    });

    store.send({ type: "increment" });
    assert.equal(callCount, 2); // Initial call + after increment

    cleanup();
    store.send({ type: "increment" });
    assert.equal(callCount, 2); // Should not have increased
  });

  it("should perform effects", async () => {
    const initialState = init();

    const decrementLater = async () => {
      await sleep(10);
      return { type: "decrement" };
    };

    const effectStore = createStore({
      state: initialState,
      update,
      fx: (_state: State, msg: Msg) => {
        if (msg.type === "increment") {
          return [decrementLater];
        }
        return [];
      },
    });

    effectStore.send({ type: "increment" });
    assert.deepEqual(effectStore.get(), { count: 1 });

    await sleep(20);

    assert.deepEqual(effectStore.get(), { count: 0 });
  });
});

describe("cursor", () => {
  type BigState = {
    user: {
      name: string;
      age: number;
    };
    settings: {
      theme: string;
    };
  };

  type UserState = BigState["user"];
  type UserMsg =
    | { type: "changeName"; name: string }
    | { type: "incrementAge" };

  const initialBigState: BigState = {
    user: { name: "John", age: 30 },
    settings: { theme: "light" },
  };

  const updateName = (state: UserState, name: string): UserState => {
    if (state.name === name) return state;
    return { ...state, name };
  };

  const updateUser = (state: UserState, msg: UserMsg): UserState => {
    switch (msg.type) {
      case "changeName":
        return updateName(state, msg.name);
      case "incrementAge":
        return { ...state, age: state.age + 1 };
      default:
        return unknown(state, msg);
    }
  };

  const userCursor = cursor<BigState, UserState, UserMsg>({
    update: updateUser,
    get: (big) => big.user,
    put: (big, small) => ({ ...big, user: small }),
  });

  it("should update the correct part of the state", () => {
    const newState = userCursor(initialBigState, {
      type: "changeName",
      name: "Alice",
    });
    assert.deepEqual(newState, {
      ...initialBigState,
      user: { ...initialBigState.user, name: "Alice" },
    });
  });

  it("should not modify other parts of the state", () => {
    const newState = userCursor(initialBigState, { type: "incrementAge" });
    assert.deepEqual(newState, {
      ...initialBigState,
      user: { ...initialBigState.user, age: 31 },
    });
    assert.deepEqual(newState.settings, initialBigState.settings);
  });

  it("should return the same state object if no changes are made", () => {
    const newState = userCursor(initialBigState, {
      type: "changeName",
      name: "John",
    });
    assert.strictEqual(newState, initialBigState);
  });
});
