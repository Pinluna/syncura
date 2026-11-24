import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

interface ToastApi {
  toast: (text: string, kind?: Toast["kind"]) => void;
  show: (text: string, kind?: Toast["kind"]) => void;
  success: (text: string) => void;
  error: (text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (text: string, kind: Toast["kind"] = "info") => {
      const id = ++counter;
      setItems((prev) => [...prev.slice(-2), { id, text, kind }]);
      setTimeout(() => remove(id), kind === "error" ? 4200 : 2600);
    },
    [remove],
  );

  const value = useMemo<ToastApi>(
    () => ({
      toast,
      show: toast,
      success: (text: string) => toast(text, "info"),
      error: (text: string) => toast(text, "error"),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
