import { assert, pattern } from "commonfabric";
import TrustedComponentExamples from "./main.tsx";

export default pattern(() => {
  const gallery = TrustedComponentExamples({});
  const assert_total_examples = assert(() => gallery.totalExamples === 52);

  return {
    tests: [{ assertion: assert_total_examples }],
    gallery,
  };
});
