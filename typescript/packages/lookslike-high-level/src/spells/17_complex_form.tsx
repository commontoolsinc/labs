import {
  h,
  Session,
} from "@commontools/common-system";
import { event, Transact } from "../sugar.js";
import { typedBehavior } from "./spell.jsx";
import { z } from "zod";

const FormTest = z.object({
  to: z.string().email().describe("The email address to send to"),
  subject: z.string().min(1).max(255).describe("The subject of the email"),
  body: z.string().min(10).max(8096).describe("The body of the email"),
  count: z.number().describe("A number!"),
  done: z.boolean().describe("Done?"),
  category: z.enum(["work", "personal", "family"]).describe("The category of the email"),
  tags: z.array(z.string()).describe("The tags of the email"),
  cc: z.array(z.object({
    email: z.string().email().describe("The email address to cc to"),
    name: z.string().describe("The name of the person to cc"),
  })).describe("The cc of the email"),
  address: z.object({
    shipping: z.object({
      streetAddress: z.string().describe("Street address for shipping"),
      city: z.string().describe("City for shipping"),
      state: z.string().length(2).describe("Two-letter state code"),
      zipCode: z.string().length(5).describe("5-digit ZIP code")
    }).describe("Shipping address details"),
    billing: z.object({
      streetAddress: z.string().describe("Street address for billing"),
      city: z.string().describe("City for billing"),
      state: z.string().length(2).describe("Two-letter state code"),
      zipCode: z.string().length(5).describe("5-digit ZIP code")
    }).describe("Billing address details")
  }).describe("Address information")
});

const Demo = z.object({})

type SubmitEvent = {
  detail: { value: z.infer<typeof FormTest> }
};

export const formTest = typedBehavior(Demo, {
  render: ({ self }) => (
    <div entity={self}>
      <common-form
        schema={FormTest}
        value={{}}
        onsubmit="~/on/save"
      />
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent>(event);
        const contact = ev.detail.value;

        cmd.add(...Transact.set(self, contact))
      }),
  })
})
