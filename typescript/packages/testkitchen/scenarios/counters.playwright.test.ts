import { expect, test } from "@playwright/test";

test("test", async ({ page }) => {
  await page.goto(
    "http://localhost:5173/newRecipe?src=http%3A%2F%2Flocalhost%3A8000%2Frecipes%2Fnew.tsx",
  );
  await page.getByRole("button", { name: "Pat random kitty" }).click();
  await page.getByRole("button", { name: "Adopt new kitty" }).click();
  await page.getByRole("button", { name: "Pat random kitty" }).click();
  await page.getByRole("button", { name: "Pat the kitty" }).click();
});
