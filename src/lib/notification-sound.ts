/**
 * Synthesized notification chime — no external audio asset, just Web
 * Audio API oscillators, so there's nothing to fetch/host/license.
 *
 * Throttled to at most once every `MIN_INTERVAL_MS` regardless of how
 * many callers fire in that window — a burst of incoming messages
 * (WhatsApp or team chat) should sound like one "you have new stuff"
 * ding, not a machine-gun of overlapping tones.
 *
 * NOTE: this file previously existed only as a hand-patched file on
 * the production VPS (never committed to git) — recreated here so the
 * repo and the running server match, and so new features (team chat)
 * can share it instead of re-implementing their own chime.
 */

const MIN_INTERVAL_MS = 2000;
let lastPlayedAt = 0;

// Reused across calls rather than a fresh AudioContext per ding —
// browsers cap the number of live contexts and creating one is not
// free. Lazily created because AudioContext must be constructed after
// a user gesture in most browsers; the first call to
// playNotificationSound() (itself triggered by a realtime event, so
// not literally a click) still works because the context starts
// "suspended" and resume() is called defensively below.
let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (sharedContext) return sharedContext;

  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;

  sharedContext = new Ctor();
  return sharedContext;
}

function tone(
  ctx: AudioContext,
  frequency: number,
  startTime: number,
  duration: number,
): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startTime);

  // Quick fade-in / fade-out so the tone doesn't click at the edges —
  // a bare on/off gain step is audible as a harsh tick.
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.15, startTime + 0.02);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);

  oscillator.connect(gain);
  gain.connect(ctx.destination);

  oscillator.start(startTime);
  oscillator.stop(startTime + duration);
}

/**
 * Play a short two-tone "ding-dong" chime. Safe to call as often as
 * you like — throttled internally, and silently does nothing in
 * environments without Web Audio support (SSR, older browsers).
 */
export function playNotificationSound(): void {
  const now = Date.now();
  if (now - lastPlayedAt < MIN_INTERVAL_MS) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  lastPlayedAt = now;

  void ctx.resume().catch(() => {
    // Autoplay-policy rejection — nothing useful to do, just skip
    // the sound this time rather than throwing into a realtime
    // callback.
  });

  const t0 = ctx.currentTime;
  tone(ctx, 880, t0, 0.15); // "ding"
  tone(ctx, 660, t0 + 0.16, 0.2); // "dong"
}
