import { createStore } from "./store.js";
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
      fx: (msg: Msg) => {
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
