// Point the booth "Camera" source at a specific capture device by name.
//
//   node scripts/set-camera.mjs "Blackmagic"     # the ATEM (Blackmagic Design)
//   node scripts/set-camera.mjs "USB Video"      # the Logitech USB webcam
//   node scripts/set-camera.mjs                   # just list the options
//
// Matches the device whose name contains the argument (case-insensitive).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import OBSWebSocket from 'obs-websocket-js';
import jpeg from 'jpeg-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = existsSync(join(ROOT, 'config.json')) ? JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')) : {};
const obsCfg = cfg.obs || { url: 'ws://127.0.0.1:4455', password: '' };
const camName = (cfg.sources && cfg.sources.camera) || 'Camera';
const want = (process.argv[2] || '').toLowerCase();

const o = new OBSWebSocket();
await o.connect(obsCfg.url, obsCfg.password || undefined);

const { propertyItems } = await o.call('GetInputPropertiesListPropertyItems', { inputName: camName, propertyName: 'video_device_id' });
const devices = (propertyItems || []).filter((i) => i.itemEnabled);

if (!want) {
  console.log(`Available devices for "${camName}":`);
  for (const d of devices) console.log(`   - ${d.itemName}`);
  console.log('\nRe-run with a name fragment, e.g.  node scripts/set-camera.mjs "Blackmagic"');
  await o.disconnect();
  process.exit(0);
}

const match = devices.find((d) => d.itemName.toLowerCase().includes(want));
if (!match) {
  console.error(`No device matching "${want}". Options: ${devices.map((d) => d.itemName).join(', ')}`);
  await o.disconnect();
  process.exit(1);
}

await o.call('SetInputSettings', {
  inputName: camName,
  inputSettings: { video_device_id: match.itemValue, last_video_device_id: match.itemValue, active: true },
  overlay: true,
});
console.log(`"${camName}" -> ${match.itemName}`);

// Report brightness so you can see whether signal is present.
await new Promise((r) => setTimeout(r, 2500));
try {
  const shot = await o.call('GetSourceScreenshot', { sourceName: camName, imageFormat: 'jpg', imageWidth: 64, imageHeight: 36, imageCompressionQuality: 60 });
  const img = jpeg.decode(Buffer.from(shot.imageData.split(',')[1], 'base64'), { useTArray: true });
  const d = img.data; let s = 0; for (let k = 0; k < d.length; k += 4) s += d[k] + d[k + 1] + d[k + 2];
  const b = s / ((d.length / 4) * 3);
  console.log(`brightness now: ${b.toFixed(1)} ${b < (cfg.watchdog?.blackThreshold ?? 12) ? '(dark / no signal yet)' : '(live picture!)'}`);
} catch (e) { console.log('brightness check failed:', e.message); }
await o.disconnect();
