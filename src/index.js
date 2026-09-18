import { loadConfig } from './config.js';
import { makeNotifier } from './notify.js';
import { makeCompanion } from './companion.js';
import { OBS } from './obs.js';
import { Booth } from './booth.js';
import { startServer } from './server.js';
import { startWatchdog } from './watchdog.js';

const cfg = loadConfig();
const notify = makeNotifier(cfg);
const setVar = makeCompanion(cfg);

const obs = new OBS(cfg);
const booth = new Booth(cfg, obs, notify, setVar);

obs.on('open', () => booth.onObsReady());
obs.on('close', () => booth.onObsClosed());

startServer(cfg, booth);
startWatchdog(cfg, obs, booth);
obs.connect();

console.log('[booth] controller started — waiting for OBS at ' + cfg.obs.url);

process.on('SIGINT', () => {
  console.log('\n[booth] shutting down');
  process.exit(0);
});
