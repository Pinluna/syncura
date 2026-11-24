import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Card, Field, Icon } from "../components/ui";
import { invalidatePairCaches, useSession } from "../lib/session";
import { useToast } from "../components/ToastProvider";
import { relativeTime } from "../lib/cycle";
import { publishStatus, subscribeRealtime } from "../lib/realtime";
import { safetyNumber } from "../lib/e2ee";
import { Logo } from "../components/Logo";
import { navigate } from "../lib/router";
import { Capacitor } from "@capacitor/core";
import { DeviceStatus, type DeviceStatusSnapshot } from "../lib/deviceStatus";

const SWITCH_STYLE: React.CSSProperties = {
  background: "none",
  border: "none",
  width: "100%",
  cursor: "pointer",
  padding: 0,
  textAlign: "left",
};

export default function Connect() {
  const { me, prefs, setPrefs } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [sharing, setSharing] = useState(me?.settings.shareLocation ?? prefs.liveSharing);
  const [geoState, setGeoState] = useState<"idle" | "requesting" | "ok" | "denied">("idle");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [safety, setSafety] = useState<string | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatusSnapshot | null>(null);

  const dash = useQuery({
    queryKey: ["dashboard"],
    queryFn: api.dashboard,
    enabled: Boolean(me?.link?.connected),
  });

  const status = dash.data?.status;
  const linked = Boolean(me?.link?.connected);
  const female = me?.user.sex === "female";

  useEffect(() => {
    if (!linked || !Capacitor.isNativePlatform()) return;
    const update = (event: Event) =>
      setDeviceStatus((event as CustomEvent<DeviceStatusSnapshot>).detail);
    window.addEventListener("syncura:device-status", update);
    void DeviceStatus.getStatus().then(setDeviceStatus).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not read this device's status");
    });
    return () => window.removeEventListener("syncura:device-status", update);
  }, [linked, toast]);

  useEffect(() => {
    setSharing(me?.settings.shareLocation ?? prefs.liveSharing);
  }, [me?.settings.shareLocation, prefs.liveSharing]);

  useEffect(
    () =>
      subscribeRealtime({
        onStatus: () => {},
      }),
    [],
  );

  const shareLocation = async () => {
    if (!navigator.geolocation) {
      setGeoState("denied");
      return;
    }
    setGeoState("requesting");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setGeoState("ok");
        const payload = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyM: Math.round(pos.coords.accuracy ?? 0),
          speedMs: pos.coords.speed ?? null,
          headingDeg: pos.coords.heading ?? null,
        };
        publishStatus(payload);
        await api.status(payload).catch(() => {});
      },
      () => setGeoState("denied"),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const toggleShare = async (next: boolean) => {
    setSharing(next);
    window.dispatchEvent(new CustomEvent("syncura:location-sharing", { detail: next }));
    setPrefs({ liveSharing: next });
    try {
      await api.settings({
        shareLocation: next,
        liveSharing: next,
      });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      if (!next) {
        publishStatus({ latitude: null, longitude: null, accuracyM: null });
        await api.status({ latitude: null, longitude: null, accuracyM: null });
      }
    } catch (e) {
      setPrefs({ liveSharing: !next });
      setSharing(!next);
      window.dispatchEvent(new CustomEvent("syncura:location-sharing", { detail: !next }));
      toast.error(e instanceof Error ? e.message : "Could not update sharing");
    }
  };

  /* Linking changes the account itself: the cached `me` still carries the old
     link state and no partner key, so every screen that depends on it has to
     be refetched before the pair chat can work. */
  const refetchPair = () => invalidatePairCaches(queryClient);

  const connect = async () => {
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length < 12) return;
    setBusy(true);
    try {
      const res = await api.connect(code.trim());
      await refetchPair();
      toast.success(`Linked with ${res.partnerName}`);
      setCode("");
      navigate("/home");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not link");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnect();
      await refetchPair();
      toast.success("Unlinked — your link is free again");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not unlink");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!me?.user.publicKey || !me?.link?.partnerPublicKey) return;
    setSafety(await safetyNumber(me.user.publicKey, me.link.partnerPublicKey));
  };

  const codeReady = code.trim().replace(/[^A-Z0-9]/g, "").length >= 12;

  if (!linked && !female) {
    return (
      <main className="authPage">
        <Logo label="Syncura" mark={34} style={{ fontSize: "1.4rem" }} />
        <div className="stack">
          <div className="pageTop">
            <h1>Connect to your partner</h1>
            <span className="sub">Enter the connection link she shared with you to continue.</span>
          </div>
          <Card title="Her connection link" icon="link">
            <Field label="Connection link">
              <div className="stack">
                <input
                  className="input"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 24))}
                  placeholder="SYNC-XXXX-XXXX-XXXX"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button type="button" className="btn primary" onClick={connect} disabled={busy || !codeReady}>
                  {busy ? "Connecting…" : "Connect"}
                </button>
              </div>
            </Field>
          </Card>
          <span className="fine">
            Your partner shares her link with you. Once connected, your shared dashboard and other features will open.
          </span>
        </div>
      </main>
    );
  }

  return (
    <div className="stack">
      <div className="pageTop">
        <h1>{female ? "Share your connection link" : "Partner"}</h1>
        <span className="sub">
          {female ? "Share your link with your partner to connect." : "Your partner connection and shared live status."}
        </span>
      </div>

      {linked ? (
        <>
          {Capacitor.isNativePlatform() && (
            <Card title="This device" icon="sparkle">
              <div className="stack">
                <span className="fine">
                  Activity, battery and steps are shared automatically. Foreground location is used to calculate speed;
                  exact coordinates are shared only while location sharing is on.
                </span>
                <dl className="facts">
                  <div>
                    <dt>Activity</dt>
                    <dd>
                      {deviceStatus?.activity === "idle"
                        ? "still"
                        : deviceStatus?.activity === "unknown"
                          ? "unavailable"
                          : deviceStatus?.activity ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Battery</dt>
                    <dd>
                      {deviceStatus?.batteryLevel != null
                        ? `${deviceStatus.batteryLevel}% · ${deviceStatus.isCharging ? "charging" : "not charging"}`
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Speed</dt>
                    <dd>{deviceStatus?.speedMs != null ? `${(deviceStatus.speedMs * 3.6).toFixed(0)} km/h` : "—"}</dd>
                  </div>
                  <div>
                    <dt>Steps today</dt>
                    <dd>{deviceStatus?.stepsToday != null ? deviceStatus.stepsToday.toLocaleString() : "—"}</dd>
                  </div>
                </dl>
                {deviceStatus && (!deviceStatus.activityPermission || !deviceStatus.locationPermission) && (
                  <span className="fine">
                    Allow activity recognition and foreground location in Android settings to enable all readings.
                  </span>
                )}
                {deviceStatus && !deviceStatus.stepSensorAvailable && (
                  <span className="fine">This phone does not provide a step counter sensor.</span>
                )}
              </div>
            </Card>
          )}
          <Card
            title={female ? "Your connection link" : `Connected with ${me?.link?.partnerName ?? "your partner"}`}
            icon="link"
            badge="linked"
          >
            <div className="stack">
              {female && (
                <>
                  <pre className="code">{me?.link?.code}</pre>
                  <span className="fine">
                    Share this link with your partner. Only a male partner can use it to connect with you.
                  </span>
                </>
              )}
              <div className="row">
                <button type="button" className="btn outline sm" onClick={verify}>
                  Safety number
                </button>
                <button type="button" className="btn danger sm" onClick={disconnect} disabled={busy}>
                  Unlink
                </button>
              </div>
              {safety && (
                <div className="card" style={{ background: "var(--muted)" }}>
                  <div className="eyebrow">Safety number</div>
                  <pre className="code" style={{ letterSpacing: "0.06em" }}>
                    {safety}
                  </pre>
                  <span className="fine">
                    Compare this with your partner in person to confirm nobody is intercepting your chat.
                  </span>
                </div>
              )}
            </div>
          </Card>

          <Card title={`${dash.data?.link?.partnerName ?? "Partner"}'s status`} icon="sparkle">
            {dash.isLoading && <span className="sub">Loading…</span>}
            <div className="stack">
              <div className="row">
                <span className={`dot ${status ? "" : "off"}`} />
                <span className="sub">
                  {status ? `Updated ${relativeTime(status.updatedAt, Date.now())}` : "No live status shared"}
                </span>
              </div>
              <dl className="facts">
                <div>
                  <dt>Activity</dt>
                  <dd>
                    {status
                      ? status.activity === "idle"
                        ? "still"
                        : status.activity === "unknown"
                          ? "unavailable"
                          : status.activity
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Battery</dt>
                  <dd>
                    {status?.batteryLevel != null
                      ? `${status.batteryLevel}% · ${status.isCharging ? "charging" : "not charging"}`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Speed</dt>
                  <dd>{status?.speedMs != null ? `${(status.speedMs * 3.6).toFixed(0)} km/h` : "—"}</dd>
                </div>
                <div>
                  <dt>Steps today</dt>
                  <dd>{status?.stepsToday != null ? status.stepsToday.toLocaleString() : "—"}</dd>
                </div>
              </dl>
            </div>
          </Card>

          <Card title="Share my live status" icon="lock">
            <div className="stack">
              <button type="button" style={SWITCH_STYLE} onClick={() => void toggleShare(!sharing)}>
                <div className="switchRow">
                  <div className="grow">
                    <strong>Location sharing</strong>
                    <span>
                      {sharing
                        ? "Your partner can see your location. Activity and device status stay shared."
                        : "Off — your location is private. Activity and device status stay shared."}
                    </span>
                  </div>
                  <span className="switch" data-state={sharing ? "checked" : "unchecked"}>
                    <span className="switchThumb" />
                  </span>
                </div>
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={shareLocation}
                disabled={!sharing || geoState === "requesting"}
              >
                <Icon name="link" />
                {geoState === "requesting" ? "Requesting…" : "Share location now"}
              </button>
              {geoState === "ok" && <span className="fine">Location shared.</span>}
              {geoState === "denied" && <span className="fine">Location permission denied.</span>}
            </div>
          </Card>
        </>
      ) : (
        <Card title="Your connection link" icon="users" badge="free">
          <div className="stack">
            <p className="sub">
              Share this link with your partner so he can connect with you.
            </p>
            <div>
              <div className="eyebrow">Your link</div>
              <pre className="code" style={{ marginTop: "0.4rem" }}>
                {me?.link?.code}
              </pre>
            </div>
            <span className="fine">
              This link stays yours. It is free right now, so send it to your partner whenever you are ready — and if you
              ever unlink, the same link comes back so you both stay on the same code.
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}

