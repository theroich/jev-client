import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";

async function goto(page: Page, route: string) {
  const session = page.waitForResponse((response) => response.url().endsWith("/api/session") && response.request().method() === "GET");
  await page.goto(route);
  await session;
}

const routes: Array<[string, string]> = [
  ["/", "Overview"],
  ["/evaluate", "Evaluate"],
  ["/templates", "Templates"],
  ["/batches", "Batches"],
  ["/history", "History"],
  ["/settings", "Settings"],
];

test.describe.serial("real console with a mocked provider", () => {
  test("six routes load SQLite without secrets or local storage", async ({ page }) => {
    for (const [route, heading] of routes) {
      await goto(page, route);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.locator(".cli-bar").last()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(await page.evaluate(() => localStorage.length)).toBe(0);
      expect(await page.content()).not.toContain("e2e-secret-key");
    }
  });

  test("evaluates, runs the demo and blocks invalid JSON", async ({ page }) => {
    await goto(page, "/evaluate");
    await expect(page.getByLabel("Model · free value allowed")).toHaveValue("e2e-configured-model");
    await page.getByRole("button", { name: "Load the ticket example" }).click();
    await expect(page.getByLabel("Model · free value allowed")).toHaveValue("e2e-configured-model");
    await page.getByRole("button", { name: "Evaluate", exact: true }).click();
    await expect(page.locator(".answer-name").filter({ hasText: "refund" })).toBeVisible();
    await expect(page.locator(".answer-name").filter({ hasText: "tone" })).toBeVisible();
    await expect(page.locator(".result-meta")).toContainText("200");
    await expect(page.locator(".result-meta")).toContainText("e2e-configured-model");
    await page.getByRole("tab", { name: "Raw JSON" }).click();
    await expect(page.locator("pre.json")).toContainText("answers");
    await page.getByRole("button", { name: "Run demo" }).click();
    await expect(page.locator(".answer-name").filter({ hasText: "is_urgent" })).toBeVisible();
    await expect(page.locator(".answer-name").filter({ hasText: "frustration" })).toBeVisible();
    await expect(page.locator(".answer-big").last()).toHaveText("1.40");
    const upload = page.getByRole("button", { name: "Upload images" });
    await expect(upload).toBeVisible();
    await expect(upload.locator("svg")).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"),
    });
    await expect(page.getByText(/photo\.png/)).toBeVisible();
    await page.getByRole("button", { name: "Remove photo.png" }).click();
    await expect(page.getByText(/photo\.png/)).toHaveCount(0);
    await page.getByLabel("Content to evaluate").fill("{bad");
    await expect(page.getByText(/Invalid JSON in state/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Evaluate", exact: true })).toBeDisabled();
  });

  test("template CRUD, validation, macros and render", async ({ page }) => {
    await goto(page, "/templates");
    await page.getByRole("button", { name: "New template", exact: true }).click();
    const starterDialog = page.getByRole("dialog", { name: "Start template" });
    await expect(starterDialog).toBeVisible();
    await expect(starterDialog.getByRole("radio", { name: /Noul/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Enter");
    await expect(starterDialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/templates\?new=1&starter=noul$/);

    const nameInput = page.getByLabel("Name", { exact: true });
    await expect(nameInput).toBeFocused();
    expect(await nameInput.evaluate((element) => element instanceof HTMLInputElement && element.selectionStart === 0 && element.selectionEnd === element.value.length)).toBe(true);
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue("A yes/no question");
    await expect(page.locator(".cli-bar").last()).toContainText("jev template create");
    await expect(page.locator(".cli-bar").last()).toContainText("--body");

    await nameInput.fill("e2e-temp");
    await page.getByLabel("Description", { exact: true }).fill("Temporary E2E template");
    await page.getByRole("button", { name: "Create template", exact: true }).click();
    await expect(page).toHaveURL(/\/templates\/e2e-temp$/);
    await expect(page.getByText("saved to SQLite", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Macros" }).click();
    await expect(page.getByText("{{order_state}}", { exact: true })).toBeVisible();
    await expect(page.getByText("0 of 3 described", { exact: true })).toBeVisible();
    const macroDescription = page.getByRole("textbox", { name: "Description of {{order_state}}" });
    await macroDescription.fill("Support ticket content");
    await expect(page.getByText("1 of 3 described", { exact: true })).toBeVisible();
    await expect(page.locator(".cli-bar").last()).toContainText("--macro-desc");
    await expect(page.locator(".cli-bar").last()).toContainText("order_state=Support ticket content");
    await macroDescription.press("Escape");
    await expect(macroDescription).toHaveValue("");
    await expect(page.getByText("0 of 3 described", { exact: true })).toBeVisible();
    await macroDescription.fill("Support ticket content");
    await page.getByRole("tab", { name: "Render" }).click();
    await page.getByLabel("Context JSON").fill('{"order_state":"real content","customer":{"name":"Ana","plan":"pro"}}');
    await page.getByRole("button", { name: "Render without sending" }).click();
    await expect(page.locator("pre.json")).toContainText("real content");
    await page.getByLabel("Name", { exact: true }).fill("e2e-renamed");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page).toHaveURL(/\/templates\/e2e-renamed$/);
    await page.getByRole("tab", { name: "Macros" }).click();
    await expect(page.getByRole("textbox", { name: "Description of {{order_state}}" })).toHaveValue("Support ticket content");
    await expect(page.getByText("1 of 3 described", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/\/templates$/);
    await expect(page.getByRole("option", { name: /e2e-renamed/ })).toHaveCount(0);
  });

  test("warns and removes the description of a macro removed from the body", async ({ page }) => {
    await goto(page, "/templates");
    await page.getByRole("button", { name: "New template", exact: true }).click();
    const starterDialog = page.getByRole("dialog", { name: "Start template" });
    await expect(starterDialog).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(starterDialog).toHaveCount(0);
    await page.getByLabel("Name", { exact: true }).fill("e2e-macro-remove");
    await page.getByRole("button", { name: "Create template", exact: true }).click();
    await expect(page).toHaveURL(/\/templates\/e2e-macro-remove$/);

    await page.getByRole("tab", { name: "Macros" }).click();
    await page.getByRole("textbox", { name: "Description of {{order_state}}" }).fill("About to be deleted");
    await expect(page.getByText("1 of 3 described", { exact: true })).toBeVisible();

    const withoutTicket = JSON.stringify({
      model: "jev-1.13",
      state: { customer: "{{customer.name}}", plan: "{{customer.plan}}" },
      questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
    }, null, 2);
    await page.getByRole("tab", { name: "Editor" }).click();
    await page.getByLabel("Template body JSON").fill(withoutTicket);
    await page.getByRole("tab", { name: "Macros" }).click();
    await expect(page.getByText(/will remove the description of \{\{order_state\}\}/)).toBeVisible();
    await expect(page.getByText("0 of 2 described", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByText("saved to SQLite", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Macros" }).click();
    await expect(page.getByRole("textbox", { name: "Description of {{order_state}}" })).toHaveCount(0);
    await expect(page.getByText("0 of 2 described", { exact: true })).toBeVisible();
    await expect(page.getByText(/will remove the description/)).toHaveCount(0);

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/\/templates$/);
  });

  test("attaches a JSON Schema to a macro, validates it and clears it", async ({ page }) => {
    await goto(page, "/templates");
    await page.getByRole("button", { name: "New template", exact: true }).click();
    const starterDialog = page.getByRole("dialog", { name: "Start template" });
    await expect(starterDialog).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(starterDialog).toHaveCount(0);
    await page.getByLabel("Name", { exact: true }).fill("e2e-schema");
    await page.getByRole("button", { name: "Create template", exact: true }).click();
    await expect(page).toHaveURL(/\/templates\/e2e-schema$/);

    await page.getByRole("tab", { name: "Macros" }).click();
    const typeSelect = page.getByLabel("Type of {{order_state}}");
    await typeSelect.selectOption("string");
    await expect(page.locator(".macro-type-chip").filter({ hasText: "string" })).toBeVisible();
    await expect(page.getByText("1 typed", { exact: true })).toBeVisible();
    await expect(page.locator(".cli-bar").last()).toContainText("--macro-schema");
    await expect(page.locator(".cli-bar").last()).toContainText('order_state={"type":"string"}');

    await page.getByRole("button", { name: "Show JSON schema of {{order_state}}" }).click();
    const schemaEditor = page.getByRole("textbox", { name: "JSON schema of {{order_state}}" });
    await expect(schemaEditor).toHaveValue('{"type":"string"}');
    await schemaEditor.fill("{bad");
    await expect(page.locator('.macro-schema-editor [role="alert"]')).toContainText(/JSON|property name|Unexpected/i);
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await expect(page.getByText("0 typed", { exact: true })).toBeVisible();

    await schemaEditor.fill('{"type":"string","enum":["pending","done"]}');
    await expect(page.getByRole("button", { name: "Format" })).toBeEnabled();
    await page.getByRole("button", { name: "Format" }).click();
    await expect(schemaEditor).toHaveValue(/"enum"/);
    await expect(page.getByText("1 typed", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByText("saved to SQLite", { exact: true })).toBeVisible();
    await expect(page.locator(".cli-bar").last()).toContainText('--macro-schema');

    await page.reload();
    await page.getByRole("tab", { name: "Macros" }).click();
    await page.getByRole("button", { name: "Show JSON schema of {{order_state}}" }).click();
    await expect(page.getByRole("textbox", { name: "JSON schema of {{order_state}}" })).toHaveValue(/"enum":/);
    await expect(page.getByText("1 typed", { exact: true })).toBeVisible();

    // `(no type)` clears the schema and keeps the description.
    await page.getByRole("textbox", { name: "Description of {{order_state}}" }).fill("Ticket content");
    await page.getByLabel("Type of {{order_state}}").selectOption("(no type)");
    await expect(page.getByText("0 typed", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Description of {{order_state}}" })).toHaveValue("Ticket content");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByText("saved to SQLite", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: "Macros" }).click();
    await expect(page.getByText("0 typed", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Description of {{order_state}}" })).toHaveValue("Ticket content");

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/\/templates$/);
  });

  test("the starters modal cancels without creating and choice/score save and render", async ({ page }) => {
    await goto(page, "/templates");
    const dialog = page.getByRole("dialog", { name: "Start template" });
    await page.getByRole("button", { name: "New template", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Noul/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowRight");
    const choiceRadio = dialog.getByRole("radio", { name: /Choice/ });
    await expect(choiceRadio).toHaveAttribute("aria-checked", "true");
    await expect(choiceRadio).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(dialog.getByRole("radio", { name: /Noul/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("new draft")).toHaveCount(0);

    const context = { order_state: "Checkout fails", customer: { name: "Luis", plan: "free" } };
    const starters = [
      { label: "Choice", id: "choice", name: "e2e-starter-choice", description: "One option among several, with descriptions", expected: "billing" },
      { label: "Score", id: "score", name: "e2e-starter-score", description: "A score within an ordered scale", expected: "Today" },
    ];

    for (const starter of starters) {
      await page.getByRole("button", { name: "New template", exact: true }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("radio", { name: new RegExp(starter.label) }).click();
      await dialog.getByRole("button", { name: "Create template" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/templates\\?new=1&starter=${starter.id}$`));
      await expect(page.getByLabel("Description", { exact: true })).toHaveValue(starter.description);
      const body = await page.getByLabel("Template body JSON").inputValue();
      expect(body).toContain(`"type": "${starter.id}"`);
      await page.getByLabel("Name", { exact: true }).fill(starter.name);
      await page.getByRole("button", { name: "Create template", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/templates/${starter.name}$`));
      await page.getByRole("tab", { name: "Render" }).click();
      await page.getByLabel("Context JSON").fill(JSON.stringify(context));
      await page.getByRole("button", { name: "Render without sending" }).click();
      await expect(page.locator("pre.json")).toContainText(starter.expected);
    }
  });

  test("batch shows progress and links history by batch", async ({ page }) => {
    await goto(page, "/batches");
    const contexts = page.getByLabel("Contexts (JSON array)");
    expect(JSON.parse(await contexts.inputValue())).toEqual([
      { "customer.name": "", "customer.plan": "", order_state: "" },
    ]);
    const orderSkeleton = JSON.stringify([{ "customer.name": "", order_state: "" }], null, 2);
    await contexts.fill('[{"own":true}]');
    await page.getByLabel("Template", { exact: true }).selectOption("order");
    await expect(contexts).toHaveValue('[{"own":true}]');
    const notice = page.locator(".callout");
    await expect(notice).toContainText("You edited the contexts");
    await notice.getByRole("button", { name: "Fill with the macros of order" }).click();
    const fillDialog = page.getByRole("dialog", { name: "Fill contexts" });
    await fillDialog.getByRole("button", { name: "Fill", exact: true }).click();
    await expect(contexts).toHaveValue(orderSkeleton);
    await page.getByRole("button", { name: "Fill with the macros of order" }).click();
    await expect(contexts).toBeFocused();
    await expect(page.getByText(/2 values are not filled in/)).toBeVisible();
    await page.getByRole("button", { name: "Run batch" }).click();
    const emptyDialog = page.getByRole("dialog", { name: "Some values are not filled in" });
    await expect(emptyDialog).toBeVisible();
    await emptyDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(emptyDialog).toHaveCount(0);
    await contexts.fill(JSON.stringify([
      { order_state: "one", customer: { name: "Ana" } },
      { order_state: "two", customer: { name: "Luis" } },
      { order_state: "three", customer: { name: "Marta" } },
    ]));
    await page.getByRole("button", { name: "Increase concurrency" }).click();
    await page.getByRole("button", { name: "Run batch" }).click();
    await expect(page.locator(".summary-grid")).toBeVisible();
    await expect(page.locator(".summary-grid")).toContainText("3");
    await expect(page.locator(".batch-item")).toHaveCount(3);
    await expect(page.locator(".batch-item .pill-ok")).toHaveCount(3);
    const batchLink = page.getByTitle("Filter history by batch");
    await expect(batchLink).toBeVisible();
    await batchLink.click();
    await expect(page).toHaveURL(/\/history\?batch=/);
    await expect(page.locator("tbody tr")).toHaveCount(3);
  });

  test("history filters, opens the detail and downloads JSONL", async ({ page }) => {
    await goto(page, "/history?status=200&limit=50");
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await page.locator("tbody tr").first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".history-detail-stack")).toBeVisible();
    await page.getByRole("tab", { name: "Response", exact: true }).click();
    await expect(page.locator("pre.json")).toContainText("answers");
    await page.getByRole("tab", { name: "Error", exact: true }).click();
    await expect(page.getByText("No error", { exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export JSONL" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("jev-history.jsonl");
    const content = await readFile(await download.path(), "utf8");
    const first = JSON.parse(content.trim().split("\n")[0]!);
    expect(first).toHaveProperty("request");
    expect(first).toHaveProperty("response");
    expect(content).not.toContain("e2e-secret-key");
  });

  test("settings save changes, reveal only on action and reset unsets", async ({ page }) => {
    await goto(page, "/settings");
    const keyInput = page.getByLabel("api_key", { exact: true });
    await expect(keyInput).not.toHaveValue("e2e-secret-key");
    await page.getByRole("button", { name: "Reveal", exact: true }).click();
    await expect(keyInput).toHaveValue("e2e-secret-key");
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(keyInput).not.toHaveValue("e2e-secret-key");
    await page.getByLabel("model · free value").fill("e2e-model");
    await page.getByLabel("timeout (s)", { exact: true }).fill("12");
    await page.getByRole("button", { name: /Save changes/ }).click();
    await expect(page.getByText("Settings saved to SQLite")).toBeVisible();
    await expect(page.locator(".prec-row").filter({ hasText: "model" })).toContainText("e2e-model");
    await page.getByRole("button", { name: "Reset to defaults" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.getByLabel("model · free value")).toHaveValue("jev-1.13");
  });

  test("palette, modal and reference work with the keyboard", async ({ page }) => {
    await goto(page, "/");
    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.getByLabel("Search commands").fill("Evaluate");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/evaluate$/);
    await page.getByRole("button", { name: "CLI reference" }).click();
    await expect(page.getByRole("dialog", { name: "CLI reference" })).toContainText("web-console");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "CLI reference" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "CLI reference" })).toBeFocused();
  });

  test("axe finds no critical violations on the six screens", async ({ page }) => {
    for (const [route] of routes) {
      await goto(page, route);
      const result = await new AxeBuilder({ page }).analyze();
      expect(result.violations.filter((violation) => violation.impact === "critical"), route).toEqual([]);
    }
  });
});
