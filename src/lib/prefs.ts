export type SoundName = "glass" | "drop" | "bubble" | "pop" | "success";

const KEYS: Record<SoundName, [number, number, number]> = {
  glass: [660, 990, 0.09],
  drop: [880, 420, 0.14],
  bubble: [380, 720, 0.12],
  pop: [520, 260, 0.1],
  success: [540, 1080, 0.18],
};

let ctx: AudioContext | null = null;
let lastAt = 0;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function playSound(name: SoundName, enabled: boolean) {
  if (!enabled) return;
  const now = performance.now();
  if (now - lastAt < 55) return;
  lastAt = now;

  const ac = audio();
  if (!ac) return;

  const [from, to, dur] = KEYS[name];
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = name === "bubble" ? "sine" : "triangle";
  osc.frequency.setValueAtTime(from, ac.currentTime);
  osc.frequency.exponentialRampToValueAtTime(to, ac.currentTime + dur);
  gain.gain.setValueAtTime(0.0001, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.16, ac.currentTime + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + dur + 0.02);
}

export function playMessageTone(direction: "sent" | "received") {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  const notes = direction === "sent" ? [880, 1174.66] : [659.25, 880];
  notes.forEach((frequency, index) => {
    const start = now + index * 0.075;
    const oscillator = ac.createOscillator();
    const gain = ac.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.045, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
    oscillator.connect(gain).connect(ac.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.12);
  });
}

export function buzz(pattern: number | number[], enabled: boolean) {
  if (!enabled) return;
  navigator.vibrate?.(pattern);
}

export function vibratePatreon(enabled: boolean) {
  buzz([18, 60, 26], enabled);
}
