import { test, expect } from "@playwright/test";

const viewports = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 600, height: 960 },
  { width: 820, height: 1180 },
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const routes = ["/", "/evaluate", "/templates", "/batches", "/history", "/settings"];

test("responsive matrix without overflow or remote assets", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname) && !["data:", "blob:"].includes(url.protocol)) external.push(request.url());
  });
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const dimensions = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth }));
      expect(dimensions.scroll, `${route} @ ${viewport.width}`).toBeLessThanOrEqual(dimensions.width + 1);
      const tokens = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return { radius: style.getPropertyValue("--radius").trim(), sidebar: style.getPropertyValue("--sidebar").trim(), accent: style.getPropertyValue("--accent").trim() };
      });
      expect(tokens.radius).toBe("8px");
      expect(tokens.sidebar).toBe("236px");
      expect(tokens.accent).not.toBe("");
    }
    const screenshot = await page.screenshot({ fullPage: true, animations: "disabled" });
    test.info().attach(`overview-${viewport.width}x${viewport.height}`, { body: screenshot, contentType: "image/png" });
  }
  expect(external).toEqual([]);
});

test("the Start template modal fits at 360 px without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/templates");
  await page.getByRole("button", { name: "New template", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start template" });
  await expect(dialog).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    modal: document.querySelector<HTMLElement>(".modal")?.scrollWidth ?? 0,
    cards: document.querySelectorAll(".starter-card").length,
  }));
  expect(dimensions.cards).toBe(3);
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.modal).toBeLessThanOrEqual(dimensions.width);
  const columns = await page.locator(".starter-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(columns.trim().split(/\s+/).length).toBe(1);
});

test("the Macros tab with a schema fits at 360 px and responds to the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/templates/order");
  await page.getByRole("tab", { name: "Macros" }).click();
  await page.getByRole("button", { name: "Show JSON schema of {{order_state}}" }).click();
  const editor = page.getByRole("textbox", { name: "JSON schema of {{order_state}}" });
  await editor.fill('{"type":"string","enum":["ok"]}');
  await expect(page.getByText("1 typed", { exact: true })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  // Esc clears the focused field without touching the description.
  await editor.focus();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveValue("");
  await expect(page.getByText("0 typed", { exact: true })).toBeVisible();
});

test("breakpoints keep the handoff geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/evaluate");
  await expect(page.locator(".grid-ask")).toHaveCSS("grid-template-columns", / \d/);
  await page.setViewportSize({ width: 1024, height: 768 });
  const columns = await page.locator(".grid-ask").evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(columns.trim().split(/\s+/).length).toBe(1);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  const statColumns = await page.locator(".stats").evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(statColumns.trim().split(/\s+/).length).toBe(1);
  await expect(page.locator("h1")).toHaveCSS("font-size", "22px");
});
