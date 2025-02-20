import type { AppRouteHandler } from "@/lib/types.ts";
import type { whoami } from "./whoami.routes.ts";

export const whoamiHandler: AppRouteHandler<typeof whoami> = async (c) => {
  const requesterProfile = {
    name: c.req.header("tailscale-user-name"),
    email: c.req.header("tailscale-user-login"),
    shortName: c.req.header("tailscale-user-login")?.split("@")[0] || "system",
    avatar: c.req.header("tailscale-user-profile-pic"),
  };

  return c.json(requesterProfile);
};
