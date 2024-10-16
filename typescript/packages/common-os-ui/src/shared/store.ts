import { debug } from "./debug.js";

/** A basic msg with no payload */
export type TypeMsg<T> = {
  type: T;
};

/* A msg with a payload */
export type ValueMsg<T, U> = {
  type: T;
  value: U;
};

export type Fx<Msg> = () => Promise<Msg>;
export type Listener<State> = (state: State) => void;
export type Cleanup = () => void;

export type Store<State, Msg> = {
  get: () => State;
  send: (msg: Msg) => void;
  sink: (listener: Listener<State>) => Cleanup;
};

export type UpdateDriver<Model, Msg> = (state: Model, msg: Msg) => Model;
export type FxDriver<Model, Msg> = (state: Model, msg: Msg) => Array<Fx<Msg>>;

/** Default fx driver. Produces no effects. */
const noFx = () => [];

/** A simple reducer store with side effects runner */
export const createStore = <State, Msg>({
  state: initial,
  msg = undefined,
  update,
  fx = noFx,
}: {
  state: State;
  msg?: Msg;
  update: UpdateDriver<State, Msg>;
  fx?: FxDriver<State, Msg>;
}): Store<State, Msg> => {
  const listeners = new Set<(state: State) => void>();
  let state = initial;

  const performEffect = async (effect: Fx<Msg>) => {
    const msg = await effect();
    if (msg != null) send(msg);
  };

  const send = (msg: Msg) => {
    if (debug()) console.debug("store", "msg", msg);
    // Generate fx
    const effects = fx(state, msg);
    // Get next state
    const next = update(state, msg);
    // Update state and notify listeners if it changed
    if (state !== next) {
      state = next;
      if (debug()) console.log("store", "state", state);
      for (const listener of listeners) {
        listener(state);
      }
    }
    // Run fx
    for (const effect of effects) {
      performEffect(effect);
    }
  };

  const sink = (listener: Listener<State>): Cleanup => {
    listener(state);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const get = () => state;

  if (msg != null) send(msg);

  return { send, sink, get };
};

export const forward =
  <ParentMsg, ChildMsg>(
    send: (msg: ParentMsg) => void,
    tag: (child: ChildMsg) => ParentMsg,
  ) =>
  (msg: ChildMsg) => {
    send(tag(msg));
  };

/** Decorate an update function so that it updates a larger element */
export const cursor =
  <BigState, SmallState, SmallMsg>({
    update,
    get,
    put,
  }: {
    update: (small: SmallState, msg: SmallMsg) => SmallState;
    get: (big: BigState) => SmallState;
    put: (big: BigState, small: SmallState) => BigState;
  }) =>
  (big: BigState, msg: SmallMsg) => {
    const small = get(big);
    const small2 = update(small, msg);
    if (small === small2) {
      return big;
    }
    return put(big, small2);
  };

/**
 * Convenience updater for update function fallthroughs when an unknown
 * message is encountered.
 */
export const unknown = <State>(state: State, msg: unknown) => {
  console.warn("Unknown message", msg);
  return state;
};

/** Map the eventual messages of an array of fx */
export const mapFx = <SmallMsg, BigMsg>(
  fx: Array<Fx<SmallMsg>>,
  transform: (msg: SmallMsg) => BigMsg,
) => fx.map((fx) => async () => transform(await fx()));
