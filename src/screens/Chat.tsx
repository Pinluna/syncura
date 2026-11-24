import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import { api, tokenStore, type CallRecord, type ChatAttachment, type Message } from "../lib/api";
import { Card, EmptyState, Icon } from "../components/ui";
import { useSession } from "../lib/session";
import { useToast } from "../components/ToastProvider";
import { subscribeRealtime, sendTyping } from "../lib/realtime";
import { decrypt, decryptBytes, encrypt, encryptBytes } from "../lib/e2ee";
import { formatTimestamp } from "../lib/cycle";
import { useCall } from "../lib/useCall";
import { playMessageTone } from "../lib/prefs";
import { saveCachedResponse } from "../lib/offline";
import { MediaViewer, type ViewerMedia } from "../components/MediaViewer";
import { CallLog } from "../components/CallLog";

function parseAttachment(content: string): ChatAttachment | null {
  try {
    const value: unknown = JSON.parse(content);
    if (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      value.kind === "syncura-attachment" &&
      "id" in value &&
      typeof value.id === "string" &&
      "name" in value &&
      typeof value.name === "string" &&
      "mimeType" in value &&
      typeof value.mimeType === "string" &&
      "size" in value &&
      typeof value.size === "number" &&
      "iv" in value &&
      typeof value.iv === "string"
    ) {
      return value as ChatAttachment;
    }
  } catch {
    return null;
  }
  return null;
}

function ViewOnceAttachment({
  attachment,
  partnerKey,
  isMine,
  openedAt,
}: {
  attachment: ChatAttachment;
  partnerKey: string;
  isMine: boolean;
  openedAt?: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [opening, setOpening] = useState(false);
  const [viewing, setViewing] = useState<ViewerMedia | null>(null);
  const activeMediaId = useRef<string | null>(null);
  const activeUrl = useRef<string | null>(null);

  const close = async () => {
    const id = activeMediaId.current;
    if (!id) return;
    activeMediaId.current = null;
    if (activeUrl.current) URL.revokeObjectURL(activeUrl.current);
    activeUrl.current = null;
    setViewing(null);
    setOpening(false);
    try {
      await api.closeViewedMedia(id);
      await queryClient.invalidateQueries({ queryKey: ["messages"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove viewed media");
    }
  };

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") void close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void close();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("keydown", onKeyDown);
      const id = activeMediaId.current;
      activeMediaId.current = null;
      if (activeUrl.current) URL.revokeObjectURL(activeUrl.current);
      activeUrl.current = null;
      if (id) {
        void api.closeViewedMedia(id)
          .then(() => queryClient.invalidateQueries({ queryKey: ["messages"] }))
          .catch((error: unknown) => console.error("Could not close view-once media after leaving chat", error));
      }
    };
  }, []);

  const open = async () => {
    if (opening || isMine || openedAt) return;
    activeMediaId.current = attachment.id;
    setOpening(true);
    try {
      const encrypted = await api.downloadMedia(attachment.id);
      const bytes = await decryptBytes(partnerKey, encrypted, attachment.iv);
      if (activeMediaId.current !== attachment.id) return;
      const blobBytes = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(blobBytes).set(bytes);
      const blob = new Blob([blobBytes], { type: attachment.mimeType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      activeUrl.current = url;
      setViewing({ url, mimeType: attachment.mimeType, name: attachment.name, size: attachment.size });
    } catch (error) {
      if (activeMediaId.current === attachment.id) {
        activeMediaId.current = null;
        try {
          await api.closeViewedMedia(attachment.id);
          await queryClient.invalidateQueries({ queryKey: ["messages"] });
        } catch (cleanupError) {
          console.error("Could not remove media after a failed view", cleanupError);
        }
      }
      toast.error(error instanceof Error ? error.message : "Could not open this media");
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="chat-attachment">
      <span className="chat-attachment-type">
        {attachment.mimeType.startsWith("image/")
          ? "Photo"
          : attachment.mimeType.startsWith("video/")
            ? "Video"
            : "Audio"}
      </span>
      <span className="chat-attachment-name">{attachment.name}</span>
      <span className="fine">
        {isMine
          ? openedAt ? "Opened once · waiting for recipient to close" : "View once · waiting for recipient"
          : openedAt ? "Already opened" : "Opens once and disappears when closed"}
      </span>
      <button type="button" className="btn ghost sm" onClick={() => void open()} disabled={opening || isMine || Boolean(openedAt)}>
        {opening ? "Opening…" : isMine ? "Sent view-once" : openedAt ? "Already viewed" : "View once"}
      </button>
      {viewing && (
        <MediaViewer
          media={viewing}
          note="View once — closes when you go back"
          onClose={() => void close()}
        />
      )}
    </div>
  );
}

/* Messages and calls share one timeline, ordered by when each thing happened.

   Calls are not chat messages -- they have no body and no bubble -- but burying
   them in a separate screen is how they get forgotten. Sorted together, a call
   that happened between two messages reads as part of the same conversation. */
type TimelineEntry =
  | { kind: "message"; at: number; id: number; message: Message }
  | { kind: "call"; at: number; id: string; record: CallRecord };

function buildTimeline(messages: Message[], calls: CallRecord[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...messages.map((message) => ({
      kind: "message" as const,
      at: new Date(message.createdAt).getTime(),
      id: message.id,
      message,
    })),
    ...calls.map((record) => ({
      kind: "call" as const,
      at: new Date(record.startedAt).getTime(),
      id: record.id,
      record,
    })),
  ];
  /* Unparseable timestamps sort to NaN, which lands them at the end rather than
     interleaving them at random. */
  return entries.sort((a, b) => {
    if (!Number.isFinite(a.at) || !Number.isFinite(b.at)) {
      return Number.isFinite(a.at) ? 1 : Number.isFinite(b.at) ? -1 : 0;
    }
    return a.at - b.at;
  });
}

function ReceiptEye({ open, label }: { open: boolean; label: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {open ? (
        <>
          <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" />
          <circle cx="12" cy="12" r="2.5" />
        </>
      ) : (
        <>
          <path d="M3 16c2.2-2.7 5.2-4 9-4s6.8 1.3 9 4" />
          <path d="M5 10.5 3.5 8.8M9 8.5 8.5 6M15 8.5l.5-2.5M19 10.5l1.5-1.7" />
        </>
      )}
    </svg>
  );
}

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    byId.set(message.id, { ...byId.get(message.id), ...message });
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export default function Chat() {
  const { me } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [decrypted, setDecrypted] = useState<Record<number, string>>({});
  const [partnerOnline, setPartnerOnline] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [showEncryptionNotice, setShowEncryptionNotice] = useState(true);
  const decrypting = useRef(new Set<number>());
  const knownMessages = useRef(new Set<number>());
  const deletedMessages = useRef(new Set<number>());
  const messageList = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const [chromeHidden, setChromeHidden] = useState(false);
  const call = useCall(me?.link?.partnerName);
  const lastReadThrough = useRef(0);
  const previousLinkId = useRef(me?.link?.id);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const partnerKey = me?.link?.partnerPublicKey ?? null;
  const linked = Boolean(me?.link?.connected && partnerKey);
  const partnerName = me?.link?.partnerName ?? "your partner";
  const messageQueryKey = ["messages", me?.link?.id] as const;

  const revealSentMessage = (message: Message, body: string) => {
    setMessages((current) => mergeMessages(current, [message]));
    queryClient.setQueryData<{ messages: Message[] }>(messageQueryKey, (current) => ({
      messages: mergeMessages(current?.messages ?? [], [message]),
    }));
    void saveCachedResponse("/chat/messages", tokenStore.get(), {
      messages: mergeMessages(queryClient.getQueryData<{ messages: Message[] }>(messageQueryKey)?.messages ?? [], [message]),
    }).catch((error: unknown) => console.error("Could not save the message for offline viewing", error));
    setDecrypted((current) => ({ ...current, [message.id]: body }));
    knownMessages.current.add(message.id);
    playMessageTone("sent");
  };

  useEffect(() => {
    if (localVideo.current) localVideo.current.srcObject = call.localStream;
    if (remoteVideo.current) remoteVideo.current.srcObject = call.remoteStream;
    if (remoteAudio.current) remoteAudio.current.srcObject = call.remoteStream;
  }, [call.localStream, call.remoteStream]);

  const msgs = useQuery({
    queryKey: messageQueryKey,
    queryFn: api.messages,
    enabled: linked,
    refetchInterval: 5000,
  });

  /* Call history, kept separately from messages because the server stores it that
     way -- but rendered inline in the timeline, so a call that happened between
     two messages sits between them rather than in a list of its own. */
  const callHistory = useQuery({
    queryKey: ["calls", me?.link?.id],
    queryFn: api.callLog,
    enabled: linked,
    refetchInterval: 10_000,
  });
  const [liveCalls, setLiveCalls] = useState<CallRecord[]>([]);
  useEffect(() => {
    setLiveCalls(callHistory.data?.calls ?? []);
  }, [callHistory.data?.calls]);

  useEffect(() => {
    if (!msgs.data?.messages) return;
    const visibleMessages = msgs.data.messages.filter((message) => !deletedMessages.current.has(message.id));
    const incoming = visibleMessages.filter((message) => !knownMessages.current.has(message.id));
    incoming.forEach((message) => knownMessages.current.add(message.id));
    setMessages((current) => {
      const fetchedCiphertexts = new Set(visibleMessages.map((message) => `${message.senderId}:${message.iv}:${message.ciphertext}`));
      const withoutSyncedPending = current.filter(
        (message) =>
          !message.pending ||
          !fetchedCiphertexts.has(`${message.senderId}:${message.iv}:${message.ciphertext}`),
      );
      return mergeMessages(withoutSyncedPending, visibleMessages);
    });
  }, [msgs.data]);

  useEffect(() => {
    const unsub = subscribeRealtime({
      onMessage: (m) => {
        if (deletedMessages.current.has(m.id)) return;
        const isNew = !knownMessages.current.has(m.id);
        knownMessages.current.add(m.id);
        if (isNew && m.senderId !== me?.user.id) playMessageTone("received");
        setMessages((prev) => mergeMessages(prev, [m]));
        queryClient.setQueryData<{ messages: Message[] }>(messageQueryKey, (current) => ({
          messages: mergeMessages(current?.messages ?? [], [m]),
        }));
        void saveCachedResponse(
          "/chat/messages",
          tokenStore.get(),
          queryClient.getQueryData<{ messages: Message[] }>(messageQueryKey) ?? { messages: [m] },
        ).catch((error: unknown) => console.error("Could not save the received message for offline viewing", error));
        void queryClient.invalidateQueries({ queryKey: ["messages"] });
      },
      onMessageDeleted: (messageId) => {
        deletedMessages.current.add(messageId);
        setMessages((current) => current.filter((message) => message.id !== messageId));
        queryClient.setQueryData<{ messages: Message[] }>(messageQueryKey, (current) => ({
          messages: (current?.messages ?? []).filter((message) => message.id !== messageId),
        }));
        setDecrypted((current) => {
          const next = { ...current };
          delete next[messageId];
          return next;
        });
      },
      onMessageReceipt: (receipt) => {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === receipt.messageId
              ? { ...message, deliveredAt: receipt.deliveredAt, readAt: receipt.readAt ?? undefined }
              : message,
          ),
        );
      },
      onTyping: (t) => setPartnerTyping(t),
      onCallLog: (records) => {
        /* The server sends only this person's row, so it merges straight in. */
        setLiveCalls((current) => {
          const byId = new Map(current.map((record) => [record.id, record]));
          records.forEach((record) => byId.set(record.id, record));
          return [...byId.values()];
        });
      },
      onPartnerPresence: (online, lastSeen) => {
        setPartnerOnline(online);
        setLastSeenAt(lastSeen);
      },
    });
    return unsub;
  }, [me?.user.id, me?.link?.id, queryClient]);

  useEffect(() => {
    if (previousLinkId.current === me?.link?.id) return;
    previousLinkId.current = me?.link?.id;
    setMessages([]);
    setDecrypted({});
    knownMessages.current.clear();
    deletedMessages.current.clear();
    lastReadThrough.current = 0;
  }, [me?.link?.id]);

  useEffect(() => {
    setShowEncryptionNotice(true);
    const timer = window.setTimeout(() => setShowEncryptionNotice(false), 3000);
    return () => window.clearTimeout(timer);
  }, [me?.link?.id]);

  useEffect(() => {
    if (!linked || !msgs.isSuccess || document.visibilityState !== "visible") return;
    const throughId = messages.reduce(
      (max, message) =>
        message.senderId !== me?.user.id && !message.readAt ? Math.max(max, message.id) : max,
      0,
    );
    if (throughId <= lastReadThrough.current) return;

    lastReadThrough.current = throughId;
    void api
      .markMessagesRead(throughId)
      .then(({ receipts }) => {
        setMessages((current) =>
          current.map((message) => {
            const receipt = receipts.find((item) => item.messageId === message.id);
            return receipt
              ? { ...message, deliveredAt: receipt.deliveredAt, readAt: receipt.readAt }
              : message;
          }),
        );
        void queryClient.invalidateQueries({ queryKey: ["messages"] });
      })
      .catch((error: unknown) => {
        lastReadThrough.current = 0;
        toastRef.current.error(error instanceof Error ? error.message : "Could not mark messages as read");
      });
  }, [linked, me?.user.id, messages, msgs.isSuccess, queryClient]);

  useEffect(() => {
    let alive = true;
    messages.forEach(async (m) => {
      if (decrypted[m.id] || !partnerKey || decrypting.current.has(m.id)) return;
      decrypting.current.add(m.id);
      try {
        const s = await decrypt(partnerKey, m.ciphertext, m.iv);
        if (!alive) return;
        setDecrypted((d) => ({ ...d, [m.id]: s }));
      } catch {
        /* An undecryptable message remains ciphertext and is not rendered as text. */
      } finally {
        decrypting.current.delete(m.id);
      }
    });
    return () => {
      alive = false;
    };
  }, [messages, partnerKey, decrypted]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateKeyboardOffset = () => {
      const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--keyboard-offset", `${offset}px`);
    };
    updateKeyboardOffset();
    viewport.addEventListener("resize", updateKeyboardOffset);
    viewport.addEventListener("scroll", updateKeyboardOffset);
    return () => {
      viewport.removeEventListener("resize", updateKeyboardOffset);
      viewport.removeEventListener("scroll", updateKeyboardOffset);
      document.documentElement.style.removeProperty("--keyboard-offset");
    };
  }, []);

  useEffect(() => {
    if (messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight;
  }, [messages, decrypted, partnerTyping]);

  const send = async () => {
    const body = text.trim();
    if (!body || !linked || !partnerKey) return;
    try {
      const encd = await encrypt(partnerKey, body);
      const res = await api.send(encd);
      revealSentMessage(res.message, body);
      setText("");
      sendTyping(false);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const sendFile = async (file: File | undefined) => {
    if (!file || !linked || !partnerKey || uploadingMedia) return;
    if (!["image/", "video/", "audio/"].some((type) => file.type.startsWith(type))) {
      toast.error("Choose a photo, video, or audio file");
      return;
    }
    if (file.size > 20 * 1024 * 1024 - 16) {
      toast.error("Media must be 20 MB or smaller");
      return;
    }
    setUploadingMedia(true);
    let uploadedId: string | null = null;
    try {
      const encryptedFile = await encryptBytes(partnerKey, await file.arrayBuffer());
      const encryptedBuffer = new ArrayBuffer(encryptedFile.ciphertext.byteLength);
      new Uint8Array(encryptedBuffer).set(encryptedFile.ciphertext);
      const uploaded = await api.uploadMedia(encryptedBuffer, true);
      uploadedId = uploaded.id;
      const content: ChatAttachment = {
        kind: "syncura-attachment",
        id: uploaded.id,
        name: file.name.slice(0, 120),
        mimeType: file.type,
        size: file.size,
        iv: encryptedFile.iv,
      };
      const encryptedMessage = await encrypt(partnerKey, JSON.stringify(content));
      const res = await api.send({ ...encryptedMessage, mediaId: uploaded.id });
      revealSentMessage(res.message, JSON.stringify(content));
      uploadedId = null;
      sendTyping(false);
    } catch (error) {
      let orphanRemains = false;
      if (uploadedId) {
        try {
          await api.deleteMedia(uploadedId);
        } catch (cleanupError) {
          orphanRemains = true;
          console.error("Could not remove a media file after its message failed", cleanupError);
        }
      }
      const message = error instanceof Error ? error.message : "Could not send this media";
      toast.error(orphanRemains ? `${message}. The uploaded file could not be removed.` : message);
    } finally {
      setUploadingMedia(false);
    }
  };

  if (!me?.link?.connected) {
    return (
      <div className="stack">
        <h1>{partnerName}</h1>
        <Card>
          <EmptyState
            icon="lock"
            title="Link first"
            hint="Connect with your partner in Connect to start an end-to-end encrypted chat."
          />
        </Card>
      </div>
    );
  }

  return (
    <section className="chat-screen">
      <header className="chat-partner-header">
        <h1>{partnerName}</h1>
        <span className="sub">
          <span className={`dot ${partnerOnline ? "" : "stale"}`} style={{ display: "inline-block", marginRight: "0.4rem" }} />
          {partnerOnline ? "Online" : lastSeenAt ? `Last seen ${formatTimestamp(lastSeenAt)}` : "Offline"}
          {showEncryptionNotice && <>{" · "}End-to-end encrypted</>}
        </span>
        <div className="row chat-call-actions">
          <button
            type="button"
            className="btn outline sm"
            disabled={!linked || call.phase !== "idle"}
            onClick={() => void call.start("audio")}
          >
            Audio call
          </button>
          <button
            type="button"
            className="btn outline sm"
            disabled={!linked || call.phase !== "idle"}
            onClick={() => void call.start("video")}
          >
            Video call
          </button>
          <span className="fine">Remote calls need TURN servers configured on your Syncura server.</span>
        </div>
      </header>
      {call.phase !== "idle" && (
        <div
          className="call-overlay"
          data-immersive={call.mode === "video" ? "true" : undefined}
          data-chrome-hidden={chromeHidden && call.mode === "video" ? "true" : undefined}
          role="dialog"
          aria-modal="true"
          aria-label="Partner call"
        >
          <div className="call-panel">
            <div className="call-topbar">
              <strong>
                {call.phase === "incoming"
                  ? `${partnerName} is calling`
                  : call.phase === "active"
                    ? `Connected to ${partnerName}`
                    : call.phase === "error"
                      ? "Call problem"
                      : `${call.mode === "video" ? "Video" : "Audio"} call`}
              </strong>
              <span className="spacer" />
              <button type="button" className="btn danger sm" onClick={call.end}>
                End
              </button>
            </div>
            {call.mode === "video" && (
              <div
                className="call-videos"
                onClick={() => setChromeHidden((hidden) => !hidden)}
                title="Tap the picture to hide or show the controls"
              >
                <video ref={remoteVideo} autoPlay playsInline />
                <video ref={localVideo} autoPlay muted playsInline />
              </div>
            )}
            {call.mode === "audio" && <audio ref={remoteAudio} autoPlay />}
            <div className="call-footer">
              {call.phase === "incoming" ? (
                <>
                  <button type="button" className="btn primary" onClick={() => void call.accept()}>
                    Accept
                  </button>
                  <button type="button" className="btn ghost" onClick={call.decline}>
                    Decline
                  </button>
                </>
              ) : call.error ? (
                <div className="stack">
                  <span className="sub">{call.error}</span>
                  <button type="button" className="btn ghost" onClick={call.dismissError}>
                    Dismiss
                  </button>
                </div>
              ) : call.phase !== "active" ? (
                <span className="sub">Connecting…</span>
              ) : null}
            </div>
          </div>
        </div>
      )}
      <div className="chat-message-list" ref={messageList}>
          {messages.length === 0 && liveCalls.length === 0 && (
            <EmptyState icon="sparkle" title="Say hi!" hint="Your messages stay between you." />
          )}
          {buildTimeline(messages, liveCalls).map((entry) => {
            if (entry.kind === "call") {
              return (
                <div key={`call-${entry.id}`} className="chat-call-entry">
                  <CallLog calls={[entry.record]} />
                </div>
              );
            }
            const m = entry.message;
            const mine = m.senderId === me.user.id;
            const content = decrypted[m.id];
            const attachment = content ? parseAttachment(content) : null;
            return (
              <div key={m.id} className={`chat-message ${mine ? "mine" : "theirs"}`}>
                <div className={`chat-bubble ${mine ? "mine" : "theirs"}`}>
                  {attachment && partnerKey ? (
                    <ViewOnceAttachment
                      attachment={attachment}
                      partnerKey={partnerKey}
                      isMine={mine}
                      openedAt={m.mediaOpenedAt}
                    />
                  ) : (
                    <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{decrypted[m.id] ?? "…"}</p>
                  )}
                  <span className="row fine" style={{ justifyContent: "flex-end", opacity: 0.85, gap: "0.3rem" }}>
                    <time dateTime={m.createdAt}>{formatTimestamp(m.createdAt)}</time>
                    {mine && m.pending && <span>Waiting to send</span>}
                    {mine && m.deliveredAt && (
                      <ReceiptEye
                        open={Boolean(m.readAt)}
                        label={m.readAt ? "Read" : "Delivered, not read"}
                      />
                    )}
                  </span>
                </div>
              </div>
            );
          })}
          {partnerTyping && (
            <div className="sub" style={{ fontSize: "0.72rem" }}>
              {me.link.partnerName ?? "Your partner"} is typing…
            </div>
          )}
      </div>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
          <input
            ref={fileInput}
            type="file"
            accept="image/*,video/*,audio/*"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void sendFile(file);
            }}
          />
          <button
            type="button"
            className="btn ghost sm icon-lg"
            aria-label={uploadingMedia ? "Sending media" : "Send photo, video, or audio"}
            title={uploadingMedia ? "Sending…" : "Send photo, video, or audio"}
            disabled={!linked || uploadingMedia}
            onClick={() => fileInput.current?.click()}
          >
            {uploadingMedia ? <span className="spin" aria-hidden="true" /> : <Paperclip size={19} />}
          </button>
          <input
            className="input"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              sendTyping(e.target.value.length > 0);
            }}
            placeholder={linked ? "Write a message" : "Link to chat"}
            disabled={!linked}
          />
          <button type="submit" className="btn primary icon-lg" disabled={!linked || !text.trim() || uploadingMedia}>
            <Icon name="send" />
          </button>
      </form>
      {!linked && <span className="fine">You need to pair with a public key exchange to send messages.</span>}
    </section>
  );
}

