"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ApiRequestError, type ApiErrorBody } from "@/lib/types";

interface Toast {
  id: number;
  message: string;
  error: boolean;
}

interface ConsoleContextValue {
  ready: boolean;
  sessionError: string | null;
  apiFetch(input: string, init?: RequestInit): Promise<Response>;
  request<T>(input: string, init?: RequestInit): Promise<T>;
  notify(message: string, error?: boolean): void;
  copy(text: string): Promise<void>;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

function errorBody(value: unknown): ApiErrorBody {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error: unknown }).error;
    if (error && typeof error === "object") {
      const body = error as Partial<ApiErrorBody>;
      if (typeof body.code === "string" && typeof body.message === "string") {
        return {
          code: body.code,
          message: body.message,
          hint: body.hint,
          details: body.details,
        };
      }
    }
  }
  return { code: "console_error", message: "The console returned an unexpected error." };
}

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const csrf = useRef("");
  const toastId = useRef(0);
  const started = useRef(false);
  const readiness = useRef<{
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);

  if (readiness.current === null) {
    let resolve = () => {};
    let reject = (_error: Error) => {};
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {});
    readiness.current = { promise, resolve, reject };
  }

  const notify = useCallback((message: string, error = false) => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, message, error }]);
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 2800);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const establish = async () => {
      try {
        const hash = window.location.hash;
        const prefix = hash.startsWith("#jev-session=")
          ? "#jev-session="
          : "#token=";
        const bootstrap = hash.startsWith(prefix)
          ? decodeURIComponent(hash.slice(prefix.length))
          : "";
        const response = await fetch("/api/session", {
          method: bootstrap ? "POST" : "GET",
          headers: bootstrap ? { "X-Jev-Console-Token": bootstrap } : {},
          credentials: "same-origin",
          cache: "no-store",
        });
        const data = (await response.json()) as { csrfToken?: string } & {
          error?: { message?: string };
        };
        if (!response.ok || !data.csrfToken) {
          throw new Error(
            data.error?.message ??
              "The session could not be validated. Restart `jev web-console` and open the URL printed by the CLI.",
          );
        }
        csrf.current = data.csrfToken;
        if (bootstrap) {
          window.history.replaceState(
            window.history.state,
            "",
            `${window.location.pathname}${window.location.search}`,
          );
        }
        setReady(true);
        readiness.current?.resolve();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSessionError(message);
        readiness.current?.reject(error instanceof Error ? error : new Error(message));
      }
    };
    void establish();
  }, []);

  const apiFetch = useCallback(async (input: string, init: RequestInit = {}) => {
    await readiness.current?.promise;
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      headers.set("X-Jev-Console-Token", csrf.current);
    }
    return fetch(input, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal,
    });
  }, []);

  const request = useCallback(
    async <T,>(input: string, init: RequestInit = {}): Promise<T> => {
      const headers = new Headers(init.headers);
      if (init.body !== undefined && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      const response = await apiFetch(input, { ...init, headers });
      const data: unknown = await response.json();
      if (!response.ok) {
        const error = errorBody(data);
        throw new ApiRequestError(error.code, error.message, error.hint, response.status, error.details);
      }
      return data as T;
    },
    [apiFetch],
  );

  const copy = useCallback(
    async (text: string) => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.readOnly = true;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          const copied = document.execCommand("copy");
          textarea.remove();
          if (!copied) throw new Error("copy rejected");
        }
        notify("Copied to clipboard");
      } catch {
        notify("Could not copy", true);
      }
    },
    [notify],
  );

  return (
    <ConsoleContext.Provider
      value={{ ready, sessionError, apiFetch, request, notify, copy }}
    >
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div className={`toast${toast.error ? " toast-error" : ""}`} key={toast.id}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              {toast.error ? <path d="M12 7v6M12 17v.1" /> : <path d="M5 12.5l4.5 4.5L19 7.5" />}
            </svg>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ConsoleContext.Provider>
  );
}

export function useConsole(): ConsoleContextValue {
  const context = useContext(ConsoleContext);
  if (!context) throw new Error("useConsole must be used inside ConsoleProvider");
  return context;
}

export function describeApiError(error: unknown): ApiErrorBody {
  if (error instanceof ApiRequestError) {
    return {
      code: error.code,
      message: error.message,
      hint: error.hint,
      details: error.details,
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "cancelled", message: "Run cancelled." };
  }
  return {
    code: "console_error",
    message: error instanceof Error ? error.message : String(error),
  };
}
