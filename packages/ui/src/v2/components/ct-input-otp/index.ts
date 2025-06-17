import { CTInputOTP } from "./ct-input-otp.ts";

if (!customElements.get("ct-input-otp")) {
  customElements.define("ct-input-otp", CTInputOTP);
}

export { CTInputOTP };
export type { CTInputOTP as CTInputOTPElement } from "./ct-input-otp.ts";
