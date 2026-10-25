import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "web", ".next", "standalone", "web");
const destination = path.join(root, "dist", "web-console");

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(path.join(source, "server.js")))) {
  throw new Error("Falta web/.next/standalone/web/server.js; ejecuta `next build web` antes de empaquetar.");
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
// Next crea un symlink bajo .next/node_modules para externalizar better-sqlite3.
// npm excluye node_modules de cualquier tarball, así que se resuelve el nombre
// interno a la dependencia declarada en el paquete raíz y se elimina el symlink.
await patchExternalAliases(path.join(destination, ".next", "server"));
await rm(path.join(destination, ".next", "node_modules"), { recursive: true, force: true });
await mkdir(path.join(destination, ".next", "static"), { recursive: true });
await cp(path.join(root, "web", ".next", "static"), path.join(destination, ".next", "static"), { recursive: true });
await cp(path.join(root, "web", "public"), path.join(destination, "public"), { recursive: true });

// El paquete raíz es ESM; el servidor standalone generado por Next es CommonJS.
await writeFile(path.join(destination, "package.json"), `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`);

if (!(await exists(path.join(destination, ".next", "BUILD_ID")))) {
  throw new Error("El standalone no contiene .next/BUILD_ID");
}
const manifest = JSON.parse(await readFile(path.join(destination, ".next", "required-server-files.json"), "utf8"));
if (!manifest) throw new Error("Manifest standalone inválido");

console.log(`Consola standalone preparada en ${path.relative(root, destination)}`);
console.log("Las dependencias trazadas se resuelven desde las dependencias npm del paquete (next, react y better-sqlite3).");

async function patchExternalAliases(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await patchExternalAliases(file);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      const sourceText = await readFile(file, "utf8");
      const patched = sourceText.replaceAll(/better-sqlite3-[a-f0-9]{8,64}/g, "better-sqlite3");
      if (patched !== sourceText) await writeFile(file, patched);
    }
  }
}
