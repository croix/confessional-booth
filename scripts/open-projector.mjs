// Open OBS's Program output fullscreen on the booth monitor.
//   node scripts/open-projector.mjs [monitorIndex]
// Default monitor index 1 (second display). Pass -1 for a windowed projector.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import OBSWebSocket from 'obs-websocket-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = existsSync(join(ROOT, 'config.json')) ? JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')) : {};
const url = cfg.obs?.url || 'ws://127.0.0.1:4455';
const pass = cfg.obs?.password || undefined;
const monitorIndex = process.argv[2] !== undefined ? Number(process.argv[2]) : 1;

const o = new OBSWebSocket();
try {
  await o.connect(url, pass);
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
