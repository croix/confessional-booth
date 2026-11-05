// Open OBS's Program output full-screen on the guest monitor.
//   node scripts/open-projector.mjs [monitor]
// [monitor] may be:
//   (omitted)  use display.projectorMonitor from config.json (default "auto")
//   auto       pick the guest monitor automatically (the non-primary display)
//   <number>   an explicit OBS monitor index (0-based)
//   -1         windowed projector
// OBS and Windows can number monitors in different orders, so "auto" asks OBS
// for its own monitor list and picks the one that isn't the primary/operator
// screen (i.e. not positioned at 0,0) — robust when the room/monitors change.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import OBSWebSocket from 'obs-websocket-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = existsSync(join(ROOT, 'config.json')) ? JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')) : {};
const url = cfg.obs?.url || 'ws://127.0.0.1:4455';
const pass = cfg.obs?.password || undefined;

const arg = process.argv[2];
const target = arg !== undefined ? arg : (cfg.display?.projectorMonitor ?? 'auto');

const o = new OBSWebSocket();
try {
  await o.connect(url, pass);

  let monitorIndex;
  if (String(target).toLowerCase() === 'auto') {
    const { monitors } = await o.call('GetMonitorList');
    if (!monitors.length) throw new Error('OBS reports no monitors');
    // Prefer a monitor that isn't the primary/operator screen (not at 0,0).
    const guest = monitors.find((m) => m.monitorPositionX !== 0 || m.monitorPositionY !== 0);
    const pick = guest || monitors[0];
    monitorIndex = pick.monitorIndex;
    console.log(`auto-selected guest monitor ${monitorIndex}: ${pick.monitorName} ${pick.monitorWidth}x${pick.monitorHeight}` + (guest ? '' : ' (only one monitor)'));
  } else {
    monitorIndex = Number(target);
  }

  await o.call('OpenVideoMixProjector', {
    videoMixType: 'OBS_WEBSOCKET_VIDEO_MIX_TYPE_PROGRAM',
    monitorIndex,
  });
  console.log(`opened Program projector on monitor ${monitorIndex}`);
  await o.disconnect();
} catch (e) {
  console.error('projector failed:', e.message);
  process.exit(1);
}
process.exit(0);
