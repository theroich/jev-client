import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ConsoleShell } from "@/components/console-shell";
import { getShellData } from "@/lib/server/runtime";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "jev · Web console", template: "%s · jev" },
  description: "Local console to operate jev-client on the same SQLite database as the CLI",
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body><ConsoleShell data={getShellData()}>{children}</ConsoleShell></body>
    </html>
  );
}
