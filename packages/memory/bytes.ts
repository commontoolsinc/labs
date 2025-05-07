import { base64 } from "npm:multiformats/bases/base64";

export type AsJSON = {
  "/": {
    bytes: string;
  };
};

/**
 * Returns bytes in [DAG-JSON](https://ipld.io/specs/codecs/dag-json/spec/#bytes)
 * format.
 */
export const toJSON = (bytes: Uint8Array): AsJSON => ({
  "/": {
    bytes: base64.baseEncode(bytes),
  },
});

/**
 * Takes bytes in [DAG-JSON](https://ipld.io/specs/codecs/dag-json/spec/#bytes)
 * format and returns those bytes in `Uint8Array`.
 */
export const fromJSON = (json: AsJSON) => base64.baseDecode(json["/"].bytes);

/**
 * Serializes bytes to string in [DAG-JSON](https://ipld.io/specs/codecs/dag-json/spec/#bytes)
 * format.
 */
export const toString = (bytes: Uint8Array) => JSON.stringify(toJSON(bytes));

/**
 * Takes bytes serialized in [DAG-JSON](https://ipld.io/specs/codecs/dag-json/spec/#bytes)
 * format and returns those bytes in `Uint8Array`.
 */
export const fromString = (source: string) => fromJSON(JSON.parse(source));
