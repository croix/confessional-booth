import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { makeNotifier } from './notify.js';
import { makeCompanion } from './companion.js';
import { OBS } from './obs.js';
import { Booth } from './booth.js';
import { startServer } from './server.js';
import { startWatchdog } from './watchdog.js';
import { makeMontage } from './montage.js';

// Remove OBS's safe-mode sentinel. OBS drops a marker here on launch and clears
// it on a clean exit; a leftover marker makes the NEXT launch pop a blocking
// "Safe Mode?" dialog that never auto-dismisses — fatal for an unattended booth.
// We wipe it while OBS is running so a crash/force-kill leaves nothing behind.
function clearObsSentinel() {
  const appdata = process.env.APPDATA;
  if (!appdata) return;
  try { rmSync(join(appdata, 'obs-studio', '.sentinel'), { recursive: true, force: true }); } catch {}
}

const cfg = loadConfig();
const notify = makeNotifier(cfg);
const setVar = makeCompanion(cfg);

const obs = new OBS(cfg);
const booth = new Booth(cfg, obs, notify, setVar);
const montage = makeMontage(cfg);

obs.on('open', () => {
  booth.onObsReady();
  clearObsSentinel(); // so a later crash won't block the relaunch on Safe Mode
  // On a cold boot OBS starts before our web server, so the "Overlay" browser
  // source loads /display and gets connection-refused (blank branding). Now that
  // we're connected (and the server is already listening), reload it. Also
  // re-asserts the overlay after any OBS reconnect.
  if (cfg.sources.overlay)
    setTimeout(() => obs.refreshBrowserSource(cfg.sources.overlay).catch(() => {}), 2000);
});
obs.on('close', () => booth.onObsClosed());

// Prepare a venue MP4 whenever a take is approved (fire-and-forget, queued).
booth.on('approved', (file) =>
  montage.prepareClip(file).catch((e) => console.error(`[montage] prepare failed: ${e.message}`)),
);
// Catch up any keepers approved before this feature existed / while stopped.
if (cfg.montage.enabled)
  montage.prepareAll().then((r) => r.built && console.log(`[montage] prepared ${r.built}/${r.total} existing keepers`)).catch(() => {});

startServer(cfg, booth, montage);
startWatchdog(cfg, obs, booth);
obs.connect();

// Heartbeat: re-push the current state to Companion every 2s. Companion loses
// its custom-variable values when it restarts, and the booth only pushes on
// state changes — so without this the Stream Deck would go blank after a
// Companion restart until the next guest action. This keeps them in sync.
setInterval(() => {
  const s = booth.getState();
  setVar('booth_state', s.state);
  setVar('booth_status', s.status);
  setVar('booth_countdown', s.countdown == null ? '' : s.countdown);
}, 2000);

console.log('[booth] controller started — waiting for OBS at ' + cfg.obs.url);

process.on('SIGINT', () => {
  console.log('\n[booth] shutting down');
  process.exit(0);
});
