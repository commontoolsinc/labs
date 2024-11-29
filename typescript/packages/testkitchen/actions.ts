export type Action = {
  type: "click";
  name: string;
  args: ["button", { name: string }];
  // {
  //   type: "click",
  //   name: "add the first kitty",
  //   args: [ "button", { name: "Add New Kitty" } ]
  // }
};

// FIXME(jake): Add timings
export type ActionResult = {
  error?: string;
  success: boolean;
  action: Action;
  duration?: number;
  screenshots?: {
    before?: string;
    after?: string;
  };
};
