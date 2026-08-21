import {
  Default,
  type FabricBytes,
  NAME,
  pattern,
  type PerSpace,
  UI,
  type VNode,
} from "commonfabric";

/**
 * Holds what a test writes and hands it back — fixture for
 * multi-runtime-fidelity.test.ts.
 *
 * `bytes` is a fabric instance and `weird` a number whose exact identity
 * matters, so what a test reads back is the fidelity of the harness's realm
 * boundary and nothing the pattern did to the value.
 */

export interface FabricValueEchoInput {
  bytes?: PerSpace<FabricBytes | undefined>;
  weird?: PerSpace<Default<number, 0>>;
}

export interface FabricValueEchoOutput {
  [NAME]: string;
  [UI]: VNode;
  bytes?: PerSpace<FabricBytes | undefined>;
  weird: PerSpace<Default<number, 0>>;
}

export default pattern<FabricValueEchoInput, FabricValueEchoOutput>(
  ({ bytes, weird }) => ({
    [NAME]: "Fabric value echo fixture",
    [UI]: (
      <div>
        <span>fabric value echo fixture</span>
      </div>
    ),
    bytes,
    weird,
  }),
);
