import { useState, useEffect, type PointerEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Card, Loading, Field, SwitchRow } from "../components/ui";
import { useSession } from "../lib/session";
import { useToast } from "../components/ToastProvider";
import { ACCENTS, useAccentTheme, useThemeMode } from "../lib/themes";
import { CYCLE_LENGTHS, PERIOD_LENGTHS, todayKey } from "../lib/cycle";
import { APP_VERSION } from "../lib/version";
import { clearApiBase, currentApiBase, isNative, setApiBase } from "../lib/config";
import { navigate } from "../lib/router";
import { chooseWallpaper, selectedWallpaper, WALLPAPERS } from "../lib/wallpaper";
import {
  isCallAlertsAvailable,
  openNotificationSettings,
  pickCallRingtone,
  readCallPreferences,
  setCallAlertsEnabled,
  setCallVibration,
  type CallAlertPreferences,
} from "../lib/callAlerts";

function colorFromHsl(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  const [r, g, b] =
    segment < 1 ? [chroma, x, 0] :
      segment < 2 ? [x, chroma, 0] :
        segment < 3 ? [0, chroma, x] :
          segment < 4 ? [0, x, chroma] :
            segment < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const match = lightness - chroma / 2;
  return `#${[r, g, b].map((value) => Math.round((value + match) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function ColorSphere({
  hue,
  saturation,
  lightness,
  onChange,
}: {
  hue: number;
  saturation: number;
  lightness: number;
  onChange: (hue: number, saturation: number) => void;
}) {
  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * 2 - 1;
    const y = (event.clientY - bounds.top) / bounds.height * 2 - 1;
    const distance = Math.min(1, Math.hypot(x, y));
    const angle = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    onChange(Math.round(angle), Math.round(distance * 100) / 100);
  };
  const knobX = 50 + 43 * saturation * Math.cos(hue * Math.PI / 180);
  const knobY = 50 + 43 * saturation * Math.sin(hue * Math.PI / 180);

  return (
    <div
      className="color-sphere"
      style={{ filter: `brightness(${lightness / 0.5})` }}
      role="slider"
      aria-label="Choose hue and saturation"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(saturation * 100)}
      aria-valuetext={`${hue} degrees hue, ${Math.round(saturation * 100)} percent saturation`}
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons !== 0) updateFromPointer(event);
      }}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "ArrowLeft") onChange((hue + 354) % 360, saturation);
        if (event.key === "ArrowRight") onChange((hue + 6) % 360, saturation);
        if (event.key === "ArrowUp") onChange(hue, Math.min(1, saturation + 0.05));
        if (event.key === "ArrowDown") onChange(hue, Math.max(0, saturation - 0.05));
      }}
    >
      <span className="color-sphere-knob" style={{ left: `${knobX}%`, top: `${knobY}%` }} />
    </div>
  );
}

export default function Settings() {
  const { me, updateMe, signOut } = useSession();
  const { theme, setTheme } = useAccentTheme();
  const { mode, setMode } = useThemeMode();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(me?.user.name ?? "");
  const [cycleLength, setCycleLength] = useState((me?.settings.cycleLength ?? 28).toString());
  const [periodLength, setPeriodLength] = useState((me?.settings.periodLength ?? 5).toString());
  const [lastPeriodStart, setLastPeriodStart] = useState(me?.settings.lastPeriodStart ?? "");
  const [savingCycle, setSavingCycle] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [serverUrl, setServerUrl] = useState(currentApiBase());

  /* Read once from the native side rather than kept in localStorage: the ringing
     screen is an Android activity and has to read the same values, so the two
     stores cannot drift. */
  const callAlertsAvailable = isCallAlertsAvailable();
  const [callPrefs, setCallPrefs] = useState<CallAlertPreferences>({
    enabled: true,
    vibrate: true,
    ringtoneUri: "",
    systemRingtoneName: "",
  });
  useEffect(() => {
    if (!callAlertsAvailable) return;
    let active = true;
    void readCallPreferences().then((prefs) => {
      if (active) setCallPrefs(prefs);
    });
    return () => {
      active = false;
    };
  }, [callAlertsAvailable]);
  const [wallpaperId, setWallpaperId] = useState(selectedWallpaper);
  const [showColorSphere, setShowColorSphere] = useState(false);
  const [customHue, setCustomHue] = useState(177);
  const [customSaturation, setCustomSaturation] = useState(0.72);
  const [customLightness, setCustomLightness] = useState(0.48);


  if (!me) return <Loading />;

  /* Saving these numbers is what marks the cycle as hers. Until then the app
     predicts nothing at all, rather than quietly using 28 and 5. */
  const saveCycle = async () => {
    if (savingCycle) return;
    setSavingCycle(true);
    try {
      await updateMe({
        cycleLength: Number(cycleLength),
        periodLength: Number(periodLength),
        lastPeriodStart: lastPeriodStart || null,
        cycleConfigured: true,
      });
      toast.success("Cycle settings saved");
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingCycle(false);
    }
  };

  const remove = async () => {
    try {
      await api.deleteAccount();
      signOut();
      /* Signed out: the app sends a signed-out person to the sign-up form. There is
         no welcome screen to go back to. */
      window.history.pushState({}, "", "/register");
      window.dispatchEvent(new Event("syncura:navigate"));
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  return (
    <div className="stack">
      <div className="pageTop">
        <h1>Settings</h1>
        <span className="sub">Profile, your cycle, appearance and data · v{APP_VERSION}</span>
      </div>

      <Card title="Profile" icon="users">
        <div className="stack">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="row">
            <span className="sub">{me.user.sex === "female" ? "Female" : "Male"}</span>
            <span className="spacer" />
            <span className="pill">{me.user.id}</span>
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={!name.trim() || name.trim() === me.user.name}
            onClick={async () => {
              try {
                await updateMe({ name: name.trim() });
                toast.success("Name saved");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Could not save");
              }
            }}
          >
            Save name
          </button>
        </div>
      </Card>

      <Card title="Your cycle" icon="calendar">
        <div className="stack">
          {me.user.sex === "female" ? (
            <>
              {!me.settings.cycleConfigured && (
                <span className="sub">
                  Your cycle is not set up, so the calendar stays empty on purpose. Fill in your own numbers below.
                </span>
              )}
              <div className="row">
                <Field label="Cycle length">
                  <select className="select" value={cycleLength} onChange={(e) => setCycleLength(e.target.value)}>
                    {CYCLE_LENGTHS.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Period length">
                  <select className="select" value={periodLength} onChange={(e) => setPeriodLength(e.target.value)}>
                    {PERIOD_LENGTHS.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Last period started">
                <input
                  type="date"
                  className="input"
                  value={lastPeriodStart}
                  max={todayKey()}
                  onChange={(e) => setLastPeriodStart(e.target.value)}
                />
              </Field>
              <button
                type="button"
                className="btn primary"
                disabled={savingCycle || !lastPeriodStart}
                onClick={saveCycle}
              >
                {savingCycle ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <span className="fine">
              Cycle predictions come from your partner's own numbers. You see her calendar in Cycle.
            </span>
          )}
        </div>
      </Card>

      <Card title="Appearance" icon="sparkle">
        <div className="stack">
          <div>
            <div className="eyebrow">Mode</div>
            <div className="chips" style={{ marginTop: "0.4rem" }}>
              {(["light", "dark", "auto"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className="chip"
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                >
                  {m[0].toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="eyebrow">Accent</div>
            <div className="chips" style={{ marginTop: "0.4rem" }}>
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="chip"
                  aria-pressed={theme.id === a.id}
                  onClick={() => setTheme({ id: a.id })}
                >
                  <span
                    aria-hidden
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      marginRight: 6,
                      background: `linear-gradient(135deg, ${a.primary}, ${a.accent})`,
                    }}
                  />
                  {a.label}
                </button>
              ))}
              <button
                type="button"
                className="chip"
                aria-pressed={theme.id === "custom" || showColorSphere}
                onClick={() => setShowColorSphere(true)}
              >
                Custom
              </button>
            </div>
          </div>
        </div>
      </Card>

      <Card title="Wallpaper" icon="sparkle">
        <div className="stack">
          <span className="sub">
            Choose a still color or blended gradient. Your selection is saved only on this device.
          </span>
          <div className="wallpaper-group">
            <strong>Solid colors</strong>
            <div className="wallpaper-grid">
              {WALLPAPERS.filter((wallpaper) => wallpaper.kind === "solid").map((wallpaper) => (
                <button
                  key={wallpaper.id}
                  type="button"
                  className="wallpaper-choice"
                  aria-pressed={wallpaperId === wallpaper.id}
                  onClick={() => {
                    try {
                      chooseWallpaper(wallpaper.id);
                      setWallpaperId(wallpaper.id);
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Could not save wallpaper");
                    }
                  }}
                >
                  <span className="wallpaper-swatch" style={{ background: wallpaper.background }} />
                  <span>{wallpaper.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="wallpaper-group">
            <details>
              <summary>Blended gradients</summary>
              <div className="wallpaper-grid">
                {WALLPAPERS.filter((wallpaper) => wallpaper.kind === "gradient").map((wallpaper) => (
                  <button
                    key={wallpaper.id}
                    type="button"
                    className="wallpaper-choice"
                    aria-pressed={wallpaperId === wallpaper.id}
                    onClick={() => {
                      try {
                        chooseWallpaper(wallpaper.id);
                        setWallpaperId(wallpaper.id);
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : "Could not save wallpaper");
                      }
                    }}
                  >
                    <span className="wallpaper-swatch" style={{ background: wallpaper.background }} />
                    <span>{wallpaper.label}</span>
                  </button>
                ))}
              </div>
            </details>
          </div>
        </div>
      </Card>
      {showColorSphere && (
        <div
          className="color-dialog-backdrop"
          role="presentation"
          onClick={() => setShowColorSphere(false)}
        >
          <section
            className="color-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="accent-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="row">
              <h2 id="accent-dialog-title" className="grow">Choose your accent</h2>
              <button type="button" className="btn ghost sm" onClick={() => setShowColorSphere(false)}>
                Close
              </button>
            </div>
            <p className="sub">Drag on the color sphere, then adjust its brightness.</p>
            <ColorSphere
              hue={customHue}
              saturation={customSaturation}
              lightness={customLightness}
              onChange={(hue, saturation) => {
                setCustomHue(hue);
                setCustomSaturation(saturation);
              }}
            />
            <label className="field">
              <span>Brightness</span>
              <input
                className="color-lightness"
                type="range"
                min={24}
                max={78}
                value={Math.round(customLightness * 100)}
                onChange={(event) => setCustomLightness(Number(event.target.value) / 100)}
              />
            </label>
            <div className="row">
              <span className="color-preview" style={{ background: colorFromHsl(customHue, customSaturation, customLightness) }} />
              <span className="sub">{colorFromHsl(customHue, customSaturation, customLightness).toUpperCase()}</span>
              <span className="spacer" />
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  setTheme({
                    id: "custom",
                    primary: colorFromHsl(customHue, customSaturation, customLightness),
                    accent: colorFromHsl((customHue + 52) % 360, customSaturation, Math.min(0.78, customLightness + 0.1)),
                  });
                  setShowColorSphere(false);
                }}
              >
                Apply accent
              </button>
            </div>
          </section>
        </div>
      )}

      <Card title="Data" icon="trash">
        <div className="stack">
          <span className="sub">
            All of your data lives in your private backend account. Deleting it removes your profile, logs and
            chat history.
          </span>
          {!confirmDelete ? (
            <button type="button" className="btn outline" onClick={() => setConfirmDelete(true)}>
              Delete account
            </button>
          ) : (
            <div className="row">
              <button type="button" className="btn danger" onClick={remove}>
                Yes, delete everything
              </button>
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </Card>

      <Card title="Calls" icon="sparkle">
        <div className="stack">
          {!callAlertsAvailable ? (
            <span className="sub">
              Ringtone and vibration are phone settings, so they only apply in the
              Android app. On the web, calls ring in the browser.
            </span>
          ) : (
            <>
              <span className="sub">
                Reach Syncura with the app closed. Syncura stays connected in the
                background so a message or a call gets through — the small
                notification below is what keeps it alive, and it is silent by
                design.
              </span>
              <SwitchRow
                title="Calls ring when the app is closed"
                description="Turn this off to stop calls and messages interrupting you at all."
                checked={callPrefs.enabled}
                onChange={(next) => {
                  setCallPrefs((current) => ({ ...current, enabled: next }));
                  void setCallAlertsEnabled(next);
                }}
              />
              <SwitchRow
                title="Vibrate for calls"
                description="In addition to the ringtone, not instead of it."
                checked={callPrefs.vibrate}
                disabled={!callPrefs.enabled}
                onChange={(next) => {
                  setCallPrefs((current) => ({ ...current, vibrate: next }));
                  void setCallVibration(next);
                }}
              />
              <Field label="Ringtone">
                <div className="row">
                  <button
                    type="button"
                    className="btn outline sm"
                    disabled={!callPrefs.enabled}
                    onClick={() => {
                      void pickCallRingtone().then((next) => {
                        if (next) setCallPrefs(next);
                      });
                    }}
                  >
                    Choose from phone
                  </button>
                  <span className="fine">
                    {callPrefs.ringtoneUri
                      ? (callPrefs.systemRingtoneName || "Chosen ringtone")
                      : `System default — ${callPrefs.systemRingtoneName || "your phone's ringtone"}`}
                  </span>
                </div>
              </Field>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => void openNotificationSettings()}
              >
                Open notification settings
              </button>
            </>
          )}
        </div>
      </Card>

      <Card title="Server" icon="link">
        <div className="stack">
          <span className="sub">
            {isNative
              ? "This app talks to a Syncura server you host. Enter its address, including https:// and without a trailing slash."
              : "The app uses the address it was loaded from. Override it only if you host the server elsewhere."}
          </span>
          <Field label="Server address">
            <input
              className="input"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://syncura.example.com"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                setApiBase(serverUrl);
                setServerUrl(currentApiBase());
                toast.success("Server address saved");
              }}
            >
              Save server
            </button>
            {currentApiBase() && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  clearApiBase();
                  setServerUrl("");
                  toast.success("Reverted to the default server");
                }}
              >
                Use default
              </button>
            )}
          </div>
        </div>
      </Card>

      <Card title="Session" icon="logout">
        <div className="stack">
          <button type="button" className="btn outline" onClick={signOut}>
            Sign out
          </button>
          {/* Signing up moved off the splash and lives here now, so the first
              screen a person sees is only the logo. It creates a second
              account rather than replacing this one -- signing out first is
              what actually switches which account is active. */}
          <span className="fine">
            Need an account on this device, or to start over? Signing up creates a
            new profile — your current one stays until you sign out of it.
          </span>
          <button
            type="button"
            className="btn ghost"
            onClick={() => navigate("/register")}
          >
            Create another account
          </button>
        </div>
      </Card>
    </div>
  );
}

