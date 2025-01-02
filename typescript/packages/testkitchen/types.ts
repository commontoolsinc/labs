
// await page.getByRole('button', { name: 'Sign in' }).click();
export type ClickAction = {
  type: "click";
  name: string;
  args: [string, { name: string }];
};

// await expect(page
//     .getByRole('listitem')
//     .filter({ has: page.getByRole('heading', { name: 'Product 2' }) }))
//     .toHaveCount(1);
export type AssertAction = {
  type: "assert";
  name: string;
  args: [string, { expected?: string, name?: string, level?: number, notVisible?: boolean }];
};

export type Action = ClickAction | AssertAction;


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
