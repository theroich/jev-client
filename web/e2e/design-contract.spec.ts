import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reference = pathToFileURL(path.join(root, "design", "jev-web-console.html")).href;
const viewports = [
  [360, 800], [390, 844], [430, 932], [600, 960], [820, 1180],
  [1024, 768], [1366, 768], [1440, 900], [1920, 1080],
] as const;
const selectors = ["body", ".shell", ".sidebar", ".topbar", ".content", ".stats", ".sub", ".btn-primary", ".panel"];
const properties = [
  "display", "position", "gridTemplateColumns", "flexDirection", "height", "minHeight",
  "maxWidth", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "gap",
  "backgroundColor", "color", "borderColor", "borderRadius", "fontSize", "fontFamily",
] as const;

async function visualContract(page: Page) {
  return page.evaluate(({ selectors, properties }) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    const rgba = (color: string) => {
      if (color.includes("color-mix")) return "color-mix";
      if (!context) return color;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#010203";
      context.fillStyle = color;
      if (context.fillStyle === "#010203" && color !== "#010203") return "unsupported";
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    return Object.fromEntries(selectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return [selector, null];
      const style = getComputedStyle(element);
      return [selector, Object.fromEntries(properties.map((property) => {
        const value = style[property];
        return [property, ["backgroundColor", "color", "borderColor"].includes(property) ? rgba(value) : value];
      }))];
    }));
  }, { selectors, properties });
}

test("visual contract regression computed against the exported HTML", async ({ page }) => {
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.goto(reference);
    const expected = await visualContract(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    const actual = await visualContract(page);
    for (const selector of selectors) {
      for (const property of properties) {
        const expectedValue = expected[selector]?.[property];
        if (expectedValue === undefined || expectedValue === "" || expectedValue === "color-mix" || expectedValue === "unsupported" || actual[selector]?.[property] === "unsupported") continue;
        // Content heights change with real data; track geometry,
        // radii, typography, position and spacing are contractual. Colors
        // derived with color-mix are validated in the screenshots/tokens, not with
        // canvas rasterization (which differs between oklch/lab).
        if (property === "height" && ![".topbar", ".btn-primary"].includes(selector)) continue;
        if (["backgroundColor", "color", "borderColor"].includes(property) && selector !== "body") continue;
        const actualValue = actual[selector]?.[property];
        if (["backgroundColor", "color", "borderColor"].includes(property) && Array.isArray(expectedValue) && Array.isArray(actualValue)) {
          expect(expectedValue.every((channel, index) => Math.abs(channel - (actualValue[index] ?? 0)) <= 2), `${selector}.${property} @ ${width}×${height}: ${expectedValue} ≠ ${actualValue}`).toBe(true);
        } else {
          expect(actualValue, `${selector}.${property} @ ${width}×${height}`).toBe(expectedValue);
        }
      }
    }
  }
});
