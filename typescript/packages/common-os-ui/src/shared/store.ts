import { debug } from "./debug.js";

export type Fx<Msg> = () => Promise<Msg>;
export type Listener<State> = (state: State) => void;
export type Cleanup = () => void;

export type Store<State, Msg> = {
  get: () => State;
  send: (msg: Msg) => void;
  sink: (listener: Listener<State>) => Cleanup;
};

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
  update: (state: State, msg: Msg) => State;
  fx?: (msg: Msg) => Array<Fx<Msg>>;
}): Store<State, Msg> => {
  const listeners = new Set<(state: State) => void>();
  let state = initial;

  const performEffect = async (effect: Fx<Msg>) => {
    const msg = await effect();
    if (msg != null) send(msg);
  };

  const send = (msg: Msg) => {
    if (debug()) console.debug("store", "msg", msg);
    const next = update(state, msg);
    if (state !== next) {
      state = next;
      if (debug()) console.log("store", "state", state);
      for (const listener of listeners) {
        listener(state);
      }
    }
    const effects = fx(msg);
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
  (big: BigState, msg: SmallMsg) =>
    put(big, update(get(big), msg));

/**
 * Convenience updater for update function fallthroughs when an unknown
 * message is encountered.
 */
export const unknown = <State>(state: State, msg: unknown) => {
  console.warn("Unknown message", msg);
  return state;
};
