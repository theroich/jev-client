import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";

async function goto(page: Page, route: string) {
  const session = page.waitForResponse((response) => response.url().endsWith("/api/session") && response.request().method() === "GET");
  await page.goto(route);
  await session;
}

const routes: Array<[string, string]> = [
  ["/", "Resumen"],
  ["/evaluar", "Evaluar"],
  ["/plantillas", "Plantillas"],
  ["/lotes", "Lotes"],
  ["/historial", "Historial"],
  ["/configuracion", "Configuración"],
];

test.describe.serial("consola real con provider mockeado", () => {
  test("seis rutas cargan SQLite sin secretos ni almacenamiento local", async ({ page }) => {
    for (const [route, heading] of routes) {
      await goto(page, route);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.locator(".cli-bar").last()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(await page.evaluate(() => localStorage.length)).toBe(0);
      expect(await page.content()).not.toContain("e2e-secret-key");
    }
  });

  test("evalúa, ejecuta demo y bloquea JSON inválido", async ({ page }) => {
    await goto(page, "/evaluar");
    await page.getByRole("button", { name: "Cargar ejemplo del ticket" }).click();
    await page.getByRole("button", { name: "Evaluar", exact: true }).click();
    await expect(page.locator(".answer-name").filter({ hasText: "refund" })).toBeVisible();
    await expect(page.locator(".answer-name").filter({ hasText: "tone" })).toBeVisible();
    await expect(page.locator(".result-meta")).toContainText("200");
    await page.getByRole("tab", { name: "JSON crudo" }).click();
    await expect(page.locator("pre.json")).toContainText("answers");
    await page.getByRole("button", { name: "Ejecutar demo" }).click();
    await expect(page.locator(".answer-name").filter({ hasText: "is_urgent" })).toBeVisible();
    await expect(page.locator(".answer-name").filter({ hasText: "frustration" })).toBeVisible();
    await expect(page.locator(".answer-big").last()).toHaveText("1.40");
    await page.getByLabel("Contenido a evaluar").fill("{bad");
    await expect(page.getByText(/JSON inválido en el state/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Evaluar", exact: true })).toBeDisabled();
  });

  test("CRUD, validación, macros y render de plantillas", async ({ page }) => {
    await goto(page, "/plantillas");
    await page.getByRole("button", { name: "Nueva plantilla", exact: true }).click();
    const starterDialog = page.getByRole("dialog", { name: "Empezar plantilla" });
    await expect(starterDialog).toBeVisible();
    await expect(starterDialog.getByRole("radio", { name: /Noul/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Enter");
    await expect(starterDialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/plantillas\?new=1&starter=noul$/);

    const nameInput = page.getByLabel("Nombre", { exact: true });
    await expect(nameInput).toBeFocused();
    expect(await nameInput.evaluate((element) => element instanceof HTMLInputElement && element.selectionStart === 0 && element.selectionEnd === element.value.length)).toBe(true);
    await expect(page.getByLabel("Descripción", { exact: true })).toHaveValue("Una pregunta de sí/no");
    await expect(page.locator(".cli-bar").last()).toContainText("jev template create");
    await expect(page.locator(".cli-bar").last()).toContainText("--body");

    await nameInput.fill("e2e-temp");
    await page.getByLabel("Descripción", { exact: true }).fill("Plantilla temporal E2E");
    await page.getByRole("button", { name: "Crear plantilla", exact: true }).click();
    await expect(page).toHaveURL(/\/plantillas\/e2e-temp$/);
    await expect(page.getByText("guardada en SQLite")).toBeVisible();
    await page.getByRole("tab", { name: "Macros" }).click();
    await expect(page.getByText("{{estado_de_pedido}}", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Renderizar" }).click();
    await page.getByLabel("Contexto JSON").fill('{"estado_de_pedido":"contenido real","cliente":{"nombre":"Ana","plan":"pro"}}');
    await page.getByRole("button", { name: "Renderizar sin enviar" }).click();
    await expect(page.locator("pre.json")).toContainText("contenido real");
    await page.getByLabel("Nombre", { exact: true }).fill("e2e-renamed");
    await page.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(page).toHaveURL(/\/plantillas\/e2e-renamed$/);
    await page.getByRole("button", { name: "Eliminar", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Eliminar", exact: true }).click();
    await expect(page).toHaveURL(/\/plantillas$/);
    await expect(page.getByRole("option", { name: /e2e-renamed/ })).toHaveCount(0);
  });

  test("el modal de starters cancela sin crear y choice/score guardan y renderizan", async ({ page }) => {
    await goto(page, "/plantillas");
    const dialog = page.getByRole("dialog", { name: "Empezar plantilla" });
    await page.getByRole("button", { name: "Nueva plantilla", exact: true }).click();
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
    await expect(page.getByText("borrador nuevo")).toHaveCount(0);

    const context = { estado_de_pedido: "El checkout falla", cliente: { nombre: "Luis", plan: "free" } };
    const starters = [
      { label: "Choice", id: "choice", name: "e2e-starter-choice", description: "Una opción entre varias, con descripciones", expected: "billing" },
      { label: "Score", id: "score", name: "e2e-starter-score", description: "Una nota dentro de una escala ordenada", expected: "Hoy mismo" },
    ];

    for (const starter of starters) {
      await page.getByRole("button", { name: "Nueva plantilla", exact: true }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("radio", { name: new RegExp(starter.label) }).click();
      await dialog.getByRole("button", { name: "Crear plantilla" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/plantillas\\?new=1&starter=${starter.id}$`));
      await expect(page.getByLabel("Descripción", { exact: true })).toHaveValue(starter.description);
      const body = await page.getByLabel("Body JSON de la plantilla").inputValue();
      expect(body).toContain(`"type": "${starter.id}"`);
      await page.getByLabel("Nombre", { exact: true }).fill(starter.name);
      await page.getByRole("button", { name: "Crear plantilla", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/plantillas/${starter.name}$`));
      await page.getByRole("tab", { name: "Renderizar" }).click();
      await page.getByLabel("Contexto JSON").fill(JSON.stringify(context));
      await page.getByRole("button", { name: "Renderizar sin enviar" }).click();
      await expect(page.locator("pre.json")).toContainText(starter.expected);
    }
  });

  test("batch muestra progreso y enlaza el historial por batch", async ({ page }) => {
    await goto(page, "/lotes");
    await page.getByLabel("Plantilla", { exact: true }).selectOption("pedido");
    await page.getByLabel("Contextos (array JSON)").fill(JSON.stringify([
      { estado_de_pedido: "uno", cliente: { nombre: "Ana" } },
      { estado_de_pedido: "dos", cliente: { nombre: "Luis" } },
      { estado_de_pedido: "tres", cliente: { nombre: "Marta" } },
    ]));
    await page.getByRole("button", { name: "Aumentar concurrencia" }).click();
    await page.getByRole("button", { name: "Ejecutar lote" }).click();
    await expect(page.locator(".summary-grid")).toBeVisible();
    await expect(page.locator(".summary-grid")).toContainText("3");
    await expect(page.locator(".batch-item")).toHaveCount(3);
    await expect(page.locator(".batch-item .pill-ok")).toHaveCount(3);
    const batchLink = page.getByTitle("Filtrar historial por batch");
    await expect(batchLink).toBeVisible();
    await batchLink.click();
    await expect(page).toHaveURL(/\/historial\?batch=/);
    await expect(page.locator("tbody tr")).toHaveCount(3);
  });

  test("historial filtra, abre detalle y descarga JSONL", async ({ page }) => {
    await goto(page, "/historial?status=200&limit=50");
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await page.locator("tbody tr").first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".history-detail-stack")).toBeVisible();
    await page.getByRole("tab", { name: "Respuesta", exact: true }).click();
    await expect(page.locator("pre.json")).toContainText("answers");
    await page.getByRole("tab", { name: "Error", exact: true }).click();
    await expect(page.getByText("Sin error", { exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportar JSONL" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("jev-history.jsonl");
    const content = await readFile(await download.path(), "utf8");
    const first = JSON.parse(content.trim().split("\n")[0]!);
    expect(first).toHaveProperty("request");
    expect(first).toHaveProperty("response");
    expect(content).not.toContain("e2e-secret-key");
  });

  test("config guarda cambios, revela solo bajo acción y reset hace unset", async ({ page }) => {
    await goto(page, "/configuracion");
    const keyInput = page.getByLabel("api_key", { exact: true });
    await expect(keyInput).not.toHaveValue("e2e-secret-key");
    await page.getByRole("button", { name: "Revelar", exact: true }).click();
    await expect(keyInput).toHaveValue("e2e-secret-key");
    await page.getByRole("button", { name: "Ocultar", exact: true }).click();
    await expect(keyInput).not.toHaveValue("e2e-secret-key");
    await page.getByLabel("model · valor libre").fill("e2e-model");
    await page.getByLabel("timeout (s)", { exact: true }).fill("12");
    await page.getByRole("button", { name: /Guardar cambios/ }).click();
    await expect(page.getByText("Configuración guardada en SQLite")).toBeVisible();
    await expect(page.locator(".prec-row").filter({ hasText: "model" })).toContainText("e2e-model");
    await page.getByRole("button", { name: "Restablecer por defecto" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restablecer", exact: true }).click();
    await expect(page.getByLabel("model · valor libre")).toHaveValue("jev-1.13");
  });

  test("paleta, modal y referencia funcionan con teclado", async ({ page }) => {
    await goto(page, "/");
    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Paleta de comandos" });
    await expect(palette).toBeVisible();
    await page.getByLabel("Buscar comandos").fill("Evaluar");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/evaluar$/);
    await page.getByRole("button", { name: "Referencia CLI" }).click();
    await expect(page.getByRole("dialog", { name: "Referencia CLI" })).toContainText("web-console");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Referencia CLI" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Referencia CLI" })).toBeFocused();
  });

  test("axe no detecta violaciones críticas en las seis pantallas", async ({ page }) => {
    for (const [route] of routes) {
      await goto(page, route);
      const result = await new AxeBuilder({ page }).analyze();
      expect(result.violations.filter((violation) => violation.impact === "critical"), route).toEqual([]);
    }
  });
});
