import { useState } from "react";
import { api, type Sex } from "../lib/api";
import { useSession } from "../lib/session";
import { ensureKeyPair } from "../lib/e2ee";
import { navigate } from "../lib/router";
import { useToast } from "../components/ToastProvider";
import { Icon } from "../components/ui";
import { Logo } from "../components/Logo";
import { currentApiBase, isNative, setApiBase } from "../lib/config";

function isoDate(d: Date): string {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
}

export default function Welcome() {
  const { signIn } = useSession();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [dob, setDob] = useState(isoDate(new Date(1998, 5, 15)));
  const [sex, setSex] = useState<Sex | null>(null);
  const [busy, setBusy] = useState(false);
  const [showServer, setShowServer] = useState(false);
  const [serverUrl, setServerUrl] = useState(currentApiBase());
  const canNext = step === 0 ? name.trim().length > 0 : step === 1 ? Boolean(dob) : Boolean(sex);

  const submit = async () => {
    if (!sex) return;
    setBusy(true);
    try {
      const publicKey = await ensureKeyPair();
      const res = await api.register({ name: name.trim(), dateOfBirth: dob, sex, publicKey });
      await signIn(res.token);
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
          </h1>
          <p className="sub" style={{ marginTop: "0.4rem" }}>
            {step === 0 && "Just a name to start — you can change anything later."}
            {step === 1 && "We use this to predict your cycle accurately."}
            {step === 2 && "This tailors predictions and partner views."}
          </p>
        </div>

        <div className="orbs" aria-hidden>
          <i />
          <i />
          <i />
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
          {step < 2 ? (
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
              {busy ? "Creating…" : "Start tracking"}
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

