import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ConsoleShell } from "@/components/console-shell";
import { getShellData } from "@/lib/server/runtime";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "jev · Consola web", template: "%s · jev" },
  description: "Consola local para operar jev-client sobre la misma SQLite que la CLI",
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body><ConsoleShell data={getShellData()}>{children}</ConsoleShell></body>
    </html>
  );
}
