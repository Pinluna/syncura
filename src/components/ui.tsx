import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/* ------------------------------------------------------------------ icon */

export function Icon({
  name,
  size = 18,
  style,
}: {
  name:
    | "drop"
    | "heart"
    | "notebook"
    | "bed"
    | "check"
    | "flame"
    | "leaf"
    | "users"
    | "link"
    | "gear"
    | "calendar"
    | "plus"
    | "trash"
    | "chevronLeft"
    | "send"
    | "sparkle"
    | "water"
    | "meal"
    | "mood"
    | "chart"
    | "lock"
    | "unlock"
    | "logout"
    | "backspace";
  size?: number;
  style?: React.CSSProperties;
}) {
  const common = {
    width: size,
    height: size,
    style,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "drop":
      return (
        <svg {...common}>
          <path d="M12 2.5c3.2 4 6 7.4 6 10.4a6 6 0 0 1-12 0C6 9.9 8.8 6.5 12 2.5Z" />
        </svg>
      );
    case "water":
      return (
        <svg {...common}>
          <path d="M4 15h16M4 15l1.5-5.5A3 3 0 0 1 8.4 7h7.2a3 3 0 0 1 2.9 2.5L20 15v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3Z" />
        </svg>
      );
    case "heart":
      return (
        <svg {...common}>
          <path d="M12 20s-7-4.5-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.7C19 15.5 12 20 12 20Z" />
        </svg>
      );
    case "notebook":
      return (
        <svg {...common}>
          <path d="M6 3h11a2 2 0 0 1 2 2v16H7a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1Z" />
          <path d="M9 8h6M9 12h6M9 16h4" />
        </svg>
      );
    case "bed":
      return (
        <svg {...common}>
          <path d="M3 18v-8h13a4 4 0 0 1 4 4v4M3 14h17M3 18h18" />
          <circle cx="7.5" cy="10" r="2" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="m4 12.5 5 5L20 6.5" />
        </svg>
      );
    case "flame":
      return (
        <svg {...common}>
          <path d="M12 22c3.9 0 6-2.6 6-6 0-4.5-4.5-6.5-4-11-3 1.5-5 4-5 6.5 0 1.4.6 2.4.6 2.4S8 12.5 7 11c-1 1.4-1.6 3-1.6 5 0 3.4 2.1 6 6.6 6Z" />
        </svg>
      );
    case "leaf":
      return (
        <svg {...common}>
          <path d="M4 20c0-8 6-14 16-15 0 10-5 15-12 15H4Z" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3 20a6 6 0 0 1 12 0M16 5.3a3.2 3.2 0 0 1 0 5.4M17.5 14.6A6 6 0 0 1 21 20" />
        </svg>
      );
    case "link":
      return (
        <svg {...common}>
          <path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.4 1.4" />
          <path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.4-1.4" />
        </svg>
      );
    case "gear":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5m15.7-6.3-1.6 1.6M7.4 16.6l-1.6 1.6m0-11.9 1.6 1.6m9.2 9.2 1.6 1.6" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="16" rx="3" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M4 7h16M9.5 7V4.8A.8.8 0 0 1 10.3 4h3.4a.8.8 0 0 1 .8.8V7M6.5 7l.9 12.2A1.8 1.8 0 0 0 9.2 21h5.6a1.8 1.8 0 0 0 1.8-1.8L17.5 7" />
        </svg>
      );
    case "chevronLeft":
      return (
        <svg {...common}>
          <path d="m14.5 5-7 7 7 7" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="M4.5 12 20 4.5 15.5 20l-3.4-5.2L4.5 12Z" />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...common}>
          <path d="M12 3.5 13.7 9l5.8 1.8-5.8 1.8L12 18.5 10.3 12.6 4.5 10.8 10.3 9 12 3.5Z" />
        </svg>
      );
    case "meal":
      return (
        <svg {...common}>
          <path d="M6 3v7a2.5 2.5 0 0 0 5 0V3M8.5 10.5V21" />
          <path d="M17.5 3c-1.7 1.4-2.5 3.4-2.5 5.5 0 2 .9 3.2 2.5 3.5V21" />
        </svg>
      );
    case "mood":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" />
        </svg>
      );
    case "chart":
      return (
        <svg {...common}>
          <path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-7" />
        </svg>
      );
    case "lock":
      return (
        <svg {...common}>
          <rect x="4.5" y="10.5" width="15" height="10.5" rx="3" />
          <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
        </svg>
      );
    case "unlock":
      return (
        <svg {...common}>
          <rect x="4.5" y="10.5" width="15" height="10.5" rx="3" />
          <path d="M8 10.5V8a4 4 0 0 1 7.5-2" />
        </svg>
      );
    case "logout":
      return (
        <svg {...common}>
          <path d="M15 5.5V4a1.5 1.5 0 0 0-1.5-1.5h-8A1.5 1.5 0 0 0 4 4v16a1.5 1.5 0 0 0 1.5 1.5h8A1.5 1.5 0 0 0 15 20v-1.5M11 12h10m0 0-3-3m3 3-3 3" />
        </svg>
      );
    case "backspace":
      return (
        <svg {...common}>
          <path d="M9 5.5h10A1.5 1.5 0 0 1 20.5 7v10a1.5 1.5 0 0 1-1.5 1.5H9L3.5 12 9 5.5Z" />
          <path d="m11.5 9.5 5 5m0-5-5 5" />
        </svg>
      );
  }
}

/* ------------------------------------------------------------------ card */

export function Card({
  icon,
  title,
  badge,
  action,
  className,
  style,
  children,
}: {
  icon?: React.ComponentProps<typeof Icon>["name"];
  title?: string;
  badge?: string;
  action?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  return (
    <section className={className ? `card ${className}` : "card"} style={style}>
      {(title || action) && (
        <header className="cardHead">
          {icon && <Icon name={icon} />}
          <strong>{title}</strong>
          {badge && <span className="badge success">{badge}</span>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ field */

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ switch */

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switchThumb" />
    </button>
  );
}

export function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="switchRow">
      <div className="grow">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={title} />
    </div>
  );
}

/* ------------------------------------------------------------------ dialog */

export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal aria-label={title} tabIndex={-1} ref={ref}>
        <h2 className="dialogTitle">{title}</h2>
        {children}
        {actions && <div className="dialogActions">{actions}</div>}
        <button
          type="button"
          className="btn ghost sm"
          style={{ position: "absolute", top: "0.6rem", right: "0.6rem" }}
          onClick={onClose}
          aria-label="Close"
        >
          <Icon name="chevronLeft" size={16} style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ states */

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" style={{ height: i === 0 ? 128 : 92 }} />
      ))}
    </div>
  );
}

export function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <section className="card errorCard">
      <div className="stack">
        <strong>Something went wrong</strong>
        <span className="sub">{message}</span>
        {onRetry && (
          <button type="button" className="btn secondary sm" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </section>
  );
}

export function EmptyState({
  icon = "leaf",
  title,
  hint,
  action,
}: {
  icon?: React.ComponentProps<typeof Icon>["name"];
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="center" style={{ padding: "1.4rem 0.5rem", flexDirection: "column", gap: "0.6rem" }}>
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: 46,
          height: 46,
          borderRadius: 999,
          background: "var(--secondary)",
          color: "var(--primary)",
        }}
      >
        <Icon name={icon} size={22} />
      </span>
      <strong style={{ fontFamily: "var(--font-family-display)" }}>{title}</strong>
      {hint && <span className="sub" style={{ textAlign: "center" }}>{hint}</span>}
      {action}
    </div>
  );
}

export { X };

