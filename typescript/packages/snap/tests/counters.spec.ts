import { test, expect } from '@playwright/test';

test.describe('Counters Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173/');
    await page.getByRole('link', { name: '👨‍🍳 Counters' }).click();
  });

  test('should allow renaming the counter', async ({ page }) => {
    await expect(page.getByRole('link', { name: '💎 Counters counters' })).toBeVisible();
    await page.getByPlaceholder('Name of counter').click();
    await page.getByPlaceholder('Name of counter').press('ControlOrMeta+a');
    await page.getByPlaceholder('Name of counter').fill('foo');
    await expect(page.locator('common-charm-link')).toContainText('💎 foo counters');
    await page.getByRole('button', { name: 'close' }).click();
  });

  test('should add multiple items and increment them', async ({ page }) => {
    // Add three items
    await page.getByRole('button', { name: 'Add new item' }).click();
    await page.getByRole('button', { name: 'Add new item' }).click();
    await page.getByRole('button', { name: 'Add new item' }).click();

    // Increment each item
    await page.getByRole('button', { name: 'inc' }).first().click();
    await page.getByRole('button', { name: 'inc' }).nth(1).click();
    await page.getByRole('button', { name: 'inc' }).nth(2).click();

    // Verify item states
    await expect(page.getByText('item 1 - 1incremove')).toBeVisible();
    await expect(page.getByText('item 2 - 1incremove')).toBeVisible();
    await expect(page.getByText('item 3 - 1incremove')).toBeVisible();
    await expect(page.getByRole('paragraph')).toContainText('Total: 3');
  });

  test('should increment random item', async ({ page }) => {
    // Add an item first
    await page.getByRole('button', { name: 'Add new item' }).click();
    
    // Test random increment
    const initialTotal = await page.getByRole('paragraph').textContent();
    await page.getByRole('button', { name: 'Inc random item' }).click();
    
    // Verify total increased
    const newTotal = await page.getByRole('paragraph').textContent();
    expect(newTotal).not.toBe(initialTotal);
  });
});