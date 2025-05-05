import { Invocation, Proof, UCAN } from "./interface.ts";
import * as Bytes from "./bytes.ts";

export type AsJSON = {
  invocation: Invocation;
  authorization: {
    access: Proof<Invocation>;
    signature: Bytes.AsJSON;
  };
};

/**
 * Turn UCAN invocation to a JSON, we need to do this in order to support byte
 * arrays.
 */
export const toJSON = ({ invocation, authorization }: UCAN<Invocation>) => ({
  invocation,
  authorization: {
    access: authorization.access,
    signature: Bytes.toJSON(authorization.signature),
  },
});

/**
 * Turns UCAN invocation in JSON format into runtime format, specifically it
 * takes care of turning DAG-JSON encoded byte arrays into Uint8Array.
 */
export const fromJSON = (
  { invocation, authorization }: AsJSON,
): UCAN<Invocation> => ({
  invocation,
  authorization: {
    access: authorization.access,
    signature: Bytes.fromJSON(authorization.signature),
  },
});

/**
 * Serializes UCAN invocation to JSON string.
 *
 * ⚠️ Note we are not able to use DAG-JSON directly because various code in the
 * system uses `/` properties in an incompatible way.
 */
export const toString = (source: UCAN<Invocation>) =>
  JSON.stringify(toJSON(source));

/**
 * Parses serialized UCAN invocation.
 *
 * ⚠️ Note we are not able to use DAG-JSON directly because various code in the
 * system uses `/` properties in an incompatible way.
 */
export const fromString = (source: string): UCAN<Invocation> =>
  fromJSON(JSON.parse(source));

export const fromStringStream = () =>
  new TransformStream<string, UCAN<Invocation>>({
    transform(chunk, controller) {
      controller.enqueue(fromString(chunk));
    },
  });

export const toStringStream = () =>
  new TransformStream<UCAN<Invocation>, string>({
    transform(chunk, controller) {
      controller.enqueue(toString(chunk));
    },
  });
