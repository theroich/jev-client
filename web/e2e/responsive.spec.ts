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
const routes = ["/", "/evaluar", "/plantillas", "/lotes", "/historial", "/configuracion"];

test("matriz responsive sin overflow ni activos remotos", async ({ page }) => {
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
    test.info().attach(`resumen-${viewport.width}x${viewport.height}`, { body: screenshot, contentType: "image/png" });
  }
  expect(external).toEqual([]);
});

test("breakpoints conservan la geometría del handoff", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/evaluar");
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
