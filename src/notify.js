// Push alerts to a phone via any webhook (ntfy.sh works great: set notify.url
// to https://ntfy.sh/your-secret-topic and install the ntfy app). Falls back to
// console logging when no url is configured. `key` gives per-alert cooldown so a
// stuck condition doesn't spam you.
export function makeNotifier(cfg) {
  const lastSent = new Map();
  return async function notify(message, key) {
    console.error(`[ALERT] ${message}`);
    if (key) {
      const now = Date.now();
      const prev = lastSent.get(key) || 0;
      if (now - prev < cfg.notify.cooldownSeconds * 1000) return;
      lastSent.set(key, now);
    }
    if (!cfg.notify.url) return;
    try {
      await fetch(cfg.notify.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Title: cfg.notify.title },
        body: message,
      });
    } catch (e) {
      console.error(`[notify] webhook POST failed: ${e.message}`);
    }
  };
}
