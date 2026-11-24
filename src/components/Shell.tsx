import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./ui";
import { useSession } from "../lib/session";
import { Logo } from "./Logo";
import { useQuery } from "@tanstack/react-query";
import { api, tokenStore } from "../lib/api";
import { OUTBOX_EVENT, pendingWriteCount } from "../lib/offline";

const BASE_NAV = [
  { path: "/home", label: "Home", icon: "heart" as const },
  { path: "/cycle", label: "Cycle", icon: "calendar" as const },
  { path: "/chat", label: "Chat", icon: "send" as const },
  { path: "/together", label: "Together", icon: "users" as const },
  { path: "/connect", label: "Connect", icon: "link" as const },
  { path: "/settings", label: "Settings", icon: "gear" as const },
];

export const NAV = BASE_NAV;

const TITLES: Record<string, string> = {
  "/home": "Syncura",
  "/cycle": "Cycle",
  "/chat": "Chat",
  "/together": "Together",
  "/connect": "Connect",
  "/settings": "Settings",
};

export function Shell({
  path,
  go,
  children,
}: {
  path: string;
  go: (next: string) => void;
  children: ReactNode;
}) {
  const { me } = useSession();
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [pendingChanges, setPendingChanges] = useState(0);
  const partnerName = me?.link?.partnerName?.trim();
  const chatLabel = partnerName || "Chat";
  const title = path === "/chat" ? chatLabel : TITLES[path] ?? "Syncura";
  const messages = useQuery({
    queryKey: ["messages", me?.link?.id],
    queryFn: api.messages,
    enabled: Boolean(me?.link?.connected),
    refetchInterval: 2_500,
  });
  const unreadCount = messages.data?.messages.filter(
    (message) => message.senderId !== me?.user.id && !message.readAt,
  ).length ?? 0;

  useEffect(() => {
    const updateStatus = () => setOnline(navigator.onLine);
    const updateQueue = () => {
      void pendingWriteCount(tokenStore.get())
        .then(setPendingChanges)
        .catch((error: unknown) => console.error("Could not read pending offline changes", error));
    };
    updateStatus();
    updateQueue();
    window.addEventListener("online", updateStatus);
    window.addEventListener("offline", updateStatus);
    window.addEventListener(OUTBOX_EVENT, updateQueue);
    return () => {
      window.removeEventListener("online", updateStatus);
      window.removeEventListener("offline", updateStatus);
      window.removeEventListener(OUTBOX_EVENT, updateQueue);
    };
  }, []);

  return (
    <div className="shell">
      <header className="header">
        <div className="headerInner">
          <Logo label={title} />
          <span className="spacer" />
          {me && <span className="sub" style={{ fontSize: "0.74rem" }}>{me.user.name}</span>}
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => go("/settings")}
            aria-label="Settings"
            style={{ padding: "0.35rem" }}
          >
            <Icon name="gear" size={18} />
          </button>
        </div>
      </header>
      {(!online || pendingChanges > 0) && (
        <div className={`offline-banner ${online ? "sync-waiting" : ""}`} role="status">
          {online
            ? `${pendingChanges} saved ${pendingChanges === 1 ? "change" : "changes"} waiting to sync`
            : `Offline · ${pendingChanges} saved ${pendingChanges === 1 ? "change" : "changes"} will sync when connected`}
        </div>
      )}
      <main className="main">{children}</main>
      <nav className="nav" aria-label="Primary">
        {NAV.map((item) => (
          <a
            key={item.path}
            href={item.path}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              go(item.path);
            }}
            aria-current={path === item.path ? "page" : undefined}
          >
            <span className="nav-icon-wrap">
              <Icon name={item.icon} />
              {item.path === "/chat" && (
                <span
                  className={`nav-unread ${unreadCount ? "visible" : ""}`}
                  aria-label={unreadCount ? `${unreadCount} unread messages` : undefined}
                  aria-hidden={!unreadCount}
                >
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </span>
            {item.path === "/chat" ? chatLabel : item.label}
          </a>
        ))}
      </nav>
    </div>
  );
}

