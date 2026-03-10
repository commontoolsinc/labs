/// <cts-enable />
import { SELF, pattern } from "commontools";

interface Input {
  value: string;
}

const _p = pattern<Input, Input>(({ [SELF]: self, value: _value }) => self);
