"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { ShellData } from "@/lib/types";
import { CliReference } from "./cli-reference";
import { CommandPalette, type PaletteAction } from "./command-palette";
import { ConsoleProvider, useConsole } from "./console-context";
import { Button, Callout, Icon, type IconName } from "./ui";

const NAVIGATION: Array<{ group: string; items: Array<{ href: string; label: string; icon: IconName; count?: "templates" | "history" }> }> = [
  { group: "Trabajo", items: [
    { href: "/", label: "Resumen", icon: "overview" },
    { href: "/evaluar", label: "Evaluar", icon: "evaluate" },
    { href: "/lotes", label: "Lotes", icon: "batch" },
  ] },
  { group: "Biblioteca", items: [
    { href: "/plantillas", label: "Plantillas", icon: "templates", count: "templates" },
    { href: "/historial", label: "Historial", icon: "history", count: "history" },
  ] },
  { group: "Sistema", items: [
    { href: "/configuracion", label: "Configuración", icon: "config" },
  ] },
];

function currentSection(pathname: string): { href: string; label: string } {
  if (pathname === "/") return { href: "/", label: "Resumen" };
  for (const group of NAVIGATION) {
    const item = group.items.find((entry) => entry.href !== "/" && pathname.startsWith(entry.href));
    if (item) return item;
  }
  return { href: "/", label: "Resumen" };
}

export function ConsoleShell({ data, children }: { data: ShellData; children: ReactNode }) {
  return <ConsoleProvider><ShellInner data={data}>{children}</ShellInner></ConsoleProvider>;
}

function ShellInner({ data, children }: { data: ShellData; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { copy, sessionError } = useConsole();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const current = currentSection(pathname);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeReference = useCallback(() => setReferenceOpen(false), []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, []);

  const actions = useMemo<PaletteAction[]>(() => [
    ...NAVIGATION.flatMap((group) => group.items.map((item) => ({
      id: `go-${item.label}`,
      group: "Ir a",
      label: item.label,
      hint: item.href === "/" ? "jev web-console" : item.href,
      run: () => router.push(item.href),
    }))),
    { id: "demo", group: "Acciones", label: "Ejecutar demo integrado", hint: "jev demo", run: () => router.push("/evaluar?run=demo") },
    { id: "new-template", group: "Acciones", label: "Nueva plantilla", hint: "jev template create", run: () => router.push("/plantillas?new=1") },
    { id: "export", group: "Acciones", label: "Exportar historial JSONL", hint: "jev history export", run: () => router.push("/historial?export=1") },
    { id: "check", group: "Acciones", label: "Probar la conexión del provider", hint: "petición real · --no-save", run: () => router.push("/?check=1") },
    { id: "reference", group: "Acciones", label: "Referencia de la CLI", hint: "jev help", run: () => setReferenceOpen(true) },
  ], [router]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" className="brand" aria-label="jev · Resumen">
          <span className="brand-mark">jev</span><span className="brand-sub">consola web</span>
        </Link>
        <nav className="nav" aria-label="Secciones">
          {NAVIGATION.map((group) => (
            <div key={group.group} style={{ display: "contents" }}>
              <p className="nav-label">{group.group}</p>
              {group.items.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <Link className="nav-item" href={item.href} key={item.href} aria-current={active ? "page" : undefined} aria-label={item.label}>
                    <Icon name={item.icon} />
                    <span className="nav-text">{item.label}</span>
                    {item.count ? <span className="count">{data.counts[item.count]}</span> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="db-chip" title="Copiar la ruta de la base SQLite" onClick={() => void copy(data.dbPath)}>
            <span>Base SQLite</span><span>{data.dbPath}</span>
          </button>
          <div className="sidebar-meta"><span>v{data.version}</span><span>esquema {data.schemaVersion}</span></div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumb"><span>jev</span><span className="sep">/</span><strong>{current.label}</strong><span className="sep">·</span><span className="mono" style={{ fontSize: 11 }}>{data.listen.host}:{data.listen.port}</span></div>
          <div className="topbar-right">
            <span className="provider" title={`Provider: ${data.provider.status}`}><span className={`dot${data.provider.status === "error" ? " off" : data.provider.status === "unknown" ? " unknown" : ""}`} /><span className="provider-model">{data.provider.model}</span></span>
            <Button variant="ghost" size="sm" onClick={() => setReferenceOpen(true)} title="Referencia de comandos CLI"><Icon name="terminal" /><span className="topbar-label">Referencia CLI</span></Button>
            <Button size="sm" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Meta+K Control+K"><Icon name="search" /><span>Buscar</span><span className="kbd">⌘K</span></Button>
          </div>
        </header>
        <main className="content">
          {sessionError ? <div className="mt-12"><Callout tone="danger">{sessionError}</Callout></div> : null}
          {children}
        </main>
      </div>
      {paletteOpen ? <CommandPalette actions={actions} onClose={closePalette} /> : null}
      {referenceOpen ? <CliReference onClose={closeReference} /> : null}
    </div>
  );
}
