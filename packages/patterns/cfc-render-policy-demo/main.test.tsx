import { assert, pattern, TESTS, Writable } from "commonfabric";
import RenderPolicyDemo, {
  TRUSTED_CONCEAL_HEALTH_DATA_ACTION,
  TRUSTED_HEALTH_DISCLOSURE_SURFACE,
  TRUSTED_REVEAL_HEALTH_DATA_ACTION,
  TrustedHealthDisclosureControls,
} from "./main.tsx";

export default pattern(() => {
  const demo = RenderPolicyDemo({});
  const revealSensitive = new Writable(false);
  const controls = TrustedHealthDisclosureControls({ revealSensitive });

  const assert_initially_hidden = assert(() => revealSensitive.get() === false);
  const assert_revealed = assert(() => revealSensitive.get() === true);
  const assert_concealed = assert(() => revealSensitive.get() === false);

  return {
    [TESTS]: [
      { assertion: assert_initially_hidden },
      {
        action: controls.reveal,
        trustedUi: {
          surface: TRUSTED_HEALTH_DISCLOSURE_SURFACE,
          action: TRUSTED_REVEAL_HEALTH_DATA_ACTION,
        },
      },
      { assertion: assert_revealed },
      {
        action: controls.conceal,
        trustedUi: {
          surface: TRUSTED_HEALTH_DISCLOSURE_SURFACE,
          action: TRUSTED_CONCEAL_HEALTH_DATA_ACTION,
        },
      },
      { assertion: assert_concealed },
    ],
    controls,
    demo,
  };
});
