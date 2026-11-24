import { useState } from "react";
import { api, type Sex } from "../lib/api";
import { useSession } from "../lib/session";
import { ensureKeyPair } from "../lib/e2ee";
import { navigate } from "../lib/router";
import { useToast } from "../components/ToastProvider";
import { Icon } from "../components/ui";
import { Logo } from "../components/Logo";
import { currentApiBase, isNative, setApiBase } from "../lib/config";
import { addDays, todayKey } from "../lib/cycle";

const CYCLE_LENGTHS = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36];
const PERIOD_LENGTHS = [2, 3, 4, 5, 6, 7];

function isoDate(d: Date): string {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
}

/* The registration form, moved off the splash. It used to be the whole welcome
   screen; it now lives at /register and is reached from Settings, so signing up
   is still possible without making it the first thing anybody sees. */
export default function Register() {
  const { signIn } = useSession();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [dob, setDob] = useState(isoDate(new Date(1998, 5, 15)));
  const [sex, setSex] = useState<Sex | null>(null);
  const [busy, setBusy] = useState(false);
  const [showServer, setShowServer] = useState(false);
  const [serverUrl, setServerUrl] = useState(currentApiBase());
  /* Her own numbers, chosen here. Nothing is predicted for her until this is
     done, so the first calendar she opens is honest rather than a guess dressed
     up as her history. */
  const [cycleLength, setCycleLength] = useState(28);
  const [periodLength, setPeriodLength] = useState(5);
  const [lastPeriodStart, setLastPeriodStart] = useState(addDays(todayKey(), -7));

  const female = sex === "female";
  const lastStep = female ? 3 : 2;
  const canNext =
    step === 0
      ? name.trim().length > 0
      : step === 1
        ? Boolean(dob)
        : step === 2
          ? Boolean(sex)
          : Boolean(lastPeriodStart) && cycleLength > periodLength;

  const submit = async () => {
    if (!sex) return;
    setBusy(true);
    try {
      const publicKey = await ensureKeyPair();
      const res = await api.register({ name: name.trim(), dateOfBirth: dob, sex, publicKey });
      await signIn(res.token);
      if (female) {
        await api.settings({
          cycleConfigured: true,
          cycleLength,
          periodLength,
          lastPeriodStart,
        });
      }
      navigate("/home");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create your account");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <main className="authPage">
        <div>
          <Logo label="Syncura" mark={34} style={{ fontSize: "1.4rem" }} />
          <h1 className="title" style={{ marginTop: "1.6rem" }}>
            {step === 0 && "Let's get to know you"}
            {step === 1 && "When were you born?"}
            {step === 2 && "How do you identify?"}
            {step === 3 && "Set up your cycle"}
          </h1>
          <p className="sub" style={{ marginTop: "0.4rem" }}>
            {step === 0 && "Just a name to start — you can change anything later."}
            {step === 1 && "We use this to predict your cycle accurately."}
            {step === 2 && "This tailors predictions and partner views."}
            {step === 3 && "Your numbers, not a default. Change them any time in Settings."}
          </p>
        </div>

        <div className="stack">
          {step === 0 && (
            <div className="field">
              <label htmlFor="name">Name</label>
              <input
                id="name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="What should we call you?"
                autoFocus
                maxLength={60}
              />
            </div>
          )}

          {step === 1 && (
            <div className="field">
              <label htmlFor="dob">Date of birth</label>
              <input
                id="dob"
                type="date"
                className="input"
                value={dob}
                max={isoDate(new Date())}
                onChange={(e) => setDob(e.target.value)}
              />
              <span className="fine">Stored with your account and used only for predictions.</span>
            </div>
          )}

          {step === 3 && (
            <>
              <div className="field">
                <label htmlFor="cycleLength">Cycle length</label>
                <select
                  id="cycleLength"
                  className="input"
                  value={cycleLength}
                  onChange={(e) => setCycleLength(Number(e.target.value))}
                >
                  {CYCLE_LENGTHS.map((value) => (
                    <option key={value} value={value}>
                      {value} days
                    </option>
                  ))}
                </select>
                <span className="fine">The gap from the first day of one period to the first day of the next.</span>
              </div>
              <div className="field">
                <label htmlFor="periodLength">Period length</label>
                <select
                  id="periodLength"
                  className="input"
                  value={periodLength}
                  onChange={(e) => setPeriodLength(Number(e.target.value))}
                >
                  {PERIOD_LENGTHS.map((value) => (
                    <option key={value} value={value}>
                      {value} days
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="lastPeriodStart">Your last period started</label>
                <input
                  id="lastPeriodStart"
                  type="date"
                  className="input"
                  value={lastPeriodStart}
                  max={todayKey()}
                  min={addDays(todayKey(), -60)}
                  onChange={(e) => setLastPeriodStart(e.target.value)}
                />
                <span className="fine">
                  Pick the closest day. Everything else on the calendar is worked out from this.
                </span>
              </div>
            </>
          )}

          {step === 2 && (
            <div className="sexRow" role="radiogroup" aria-label="Sex">
              <button
                type="button"
                className="sexTile"
                role="radio"
                aria-checked={sex === "female"}
                onClick={() => setSex("female")}
              >
                <strong>Female</strong>
                <small>I'll be tracking my cycle</small>
              </button>
              <button
                type="button"
                className="sexTile"
                role="radio"
                aria-checked={sex === "male"}
                onClick={() => setSex("male")}
              >
                <strong>Male</strong>
                <small>Supporting a partner</small>
              </button>
            </div>
          )}
        </div>

        <div className="grow" />

        <div className="stack">
          {step < lastStep ? (
            <button
              type="button"
              className="btn primary lg"
              disabled={!canNext}
              onClick={() => setStep((s) => s + 1)}
            >
              Continue
              <Icon name="chevronLeft" size={16} style={{ transform: "rotate(180deg)" }} />
            </button>
          ) : (
            <button type="button" className="btn primary lg" disabled={!canNext || busy} onClick={submit}>
              {busy ? "Creating…" : female ? "Start tracking" : "Create account"}
            </button>
          )}
          {step > 0 && (
            <button type="button" className="btn ghost" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          )}
          {isNative && (
            <div className="stack">
              {showServer ? (
                <>
                  <div className="field">
                    <label htmlFor="server">Server address</label>
                    <input
                      id="server"
                      className="input"
                      value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                      placeholder="https://syncura.example.com"
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <span className="fine">
                      Paste the whole invite link if this server is invite-only — the access code
                      inside it is saved for you.
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn outline sm"
                    onClick={() => {
                      setApiBase(serverUrl);
                      setServerUrl(currentApiBase());
                      setShowServer(false);
                    }}
                  >
                    Save server address
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setShowServer(true)}
                  style={{ alignSelf: "center" }}
                >
                  Using a self-hosted server?
                </button>
              )}
            </div>
          )}

          <p className="fine" style={{ textAlign: "center" }}>
            Your account is private to you. Pair with someone to share — and messages stay end-to-end encrypted.
          </p>
          {!isNative && (
            <p className="fine" style={{ textAlign: "center" }}>
              Prefer a phone?{" "}
              <a href="/syncura.apk" download>
                Download the Android app
              </a>
            </p>
          )}
        </div>
      </main>
    </>
  );
}
