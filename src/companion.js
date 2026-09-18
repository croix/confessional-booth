// Push the booth's current state into Companion custom variables so the Stream
// Deck keys can light up / hide per state. The variables (booth_state,
// booth_status, booth_countdown) must be created once in Companion's
// Custom Variables tab, and Companion's HTTP API must be enabled.
export function makeCompanion(cfg) {
  return async function setVar(name, value) {
    if (!cfg.companion.baseUrl) return;
    const url = `${cfg.companion.baseUrl}/api/custom-variable/${encodeURIComponent(name)}/value`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: String(value),
      });
    } catch (e) {
      console.error(`[companion] set ${name} failed: ${e.message}`);
    }
  };
}
