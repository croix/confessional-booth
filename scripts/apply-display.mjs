// Wire the branded full-screen display into the OBS scenes.
//
//   node scripts/apply-display.mjs
//
// - Adds a Browser Source "Overlay" (http://127.0.0.1:3939/display) on top of
//   every scene. It's one shared source, so it keeps polling across scene cuts.
// - Makes the camera / review video fill the 1920x1080 canvas (full-bleed).
// - Hides the old plain txt_* sources (the overlay renders all text now).
//
// Safe to re-run. Requires OBS running + the controller serving /display.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import OBSWebSocket from 'obs-websocket-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = existsSync(join(ROOT, 'config.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
  : {};
const obsCfg = cfg.obs || { url: 'ws://127.0.0.1:4455', password: '' };
const S = cfg.scenes || { ready: 'READY', attract: 'ATTRACT', countdown: 'COUNTDOWN', recording: 'RECORDING', review: 'REVIEW', thanks: 'THANKS' };
const SRC = cfg.sources || { camera: 'Camera', reviewMedia: 'mediaReview' };
const port = (cfg.server && cfg.server.port) || 3939;
const DISPLAY_URL = `http://127.0.0.1:${port}/display`;
const OVERLAY = 'Overlay';
const CANVAS = { w: 1920, h: 1080 };

const obs = new OBSWebSocket();

async function itemId(scene, source) {
  const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene });
  const hit = sceneItems.find((i) => i.sourceName === source);
  return hit ? hit.sceneItemId : null;
}

async function fill(scene, source, boundsType) {
  const id = await itemId(scene, source);
  if (id == null) return;
  await obs.call('SetSceneItemTransform', {
    sceneName: scene,
    sceneItemId: id,
    sceneItemTransform: {
      positionX: CANVAS.w / 2,
      positionY: CANVAS.h / 2,
      alignment: 0, // center
      boundsType,
      boundsAlignment: 0, // center
      boundsWidth: CANVAS.w,
      boundsHeight: CANVAS.h,
    },
  });
}

async function ensureOverlayInput() {
  const { inputs } = await obs.call('GetInputList');
  if (!inputs.find((i) => i.inputName === OVERLAY)) {
    // Create it unattached first; we place it per-scene below.
    await obs.call('CreateInput', {
      sceneName: S.ready,
      inputName: OVERLAY,
      inputKind: 'browser_source',
      inputSettings: { url: DISPLAY_URL, width: CANVAS.w, height: CANVAS.h, reroute_audio: false, shutdown: false, restart_when_active: false },
      sceneItemEnabled: true,
    });
    console.log('[display] created Overlay browser source');
  } else {
    await obs.call('SetInputSettings', {
      inputName: OVERLAY,
      inputSettings: { url: DISPLAY_URL, width: CANVAS.w, height: CANVAS.h, shutdown: false, restart_when_active: false },
      overlay: true,
    });
    console.log('[display] updated Overlay browser source URL/size');
  }
}

async function ensureOverlayOnTop(scene) {
  let id = await itemId(scene, OVERLAY);
  if (id == null) {
    const created = await obs.call('CreateSceneItem', { sceneName: scene, sourceName: OVERLAY, sceneItemEnabled: true });
    id = created.sceneItemId;
  }
  // Fit exactly to canvas, then raise to the top of the list.
  await fill(scene, OVERLAY, 'OBS_BOUNDS_STRETCH');
  const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene });
  await obs.call('SetSceneItemIndex', { sceneName: scene, sceneItemId: id, sceneItemIndex: sceneItems.length - 1 });
}

async function hideText(scene) {
  const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene });
  for (const it of sceneItems) {
    if (/^txt/i.test(it.sourceName)) {
      await obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: it.sceneItemId, sceneItemEnabled: false });
    }
  }
}

async function main() {
  await obs.connect(obsCfg.url, obsCfg.password || undefined);
  console.log('[display] connected to OBS');

  await ensureOverlayInput();

  const liveScenes = [S.ready, S.attract, S.countdown, S.recording];
  for (const sc of liveScenes) await fill(sc, SRC.camera, 'OBS_BOUNDS_SCALE_OUTER'); // full-bleed camera
  await fill(S.review, SRC.reviewMedia, 'OBS_BOUNDS_SCALE_OUTER'); // full-bleed playback

  for (const sc of [S.ready, S.attract, S.countdown, S.recording, S.review, S.thanks]) {
    await ensureOverlayOnTop(sc);
    await hideText(sc);
    console.log(`[display] wired ${sc}`);
  }

  console.log('\n[display] DONE. The booth monitor now shows the branded app.');
  console.log('[display] Right-click the preview in OBS -> Fullscreen Projector -> booth monitor.');
  await obs.disconnect();
}

main().catch(async (e) => {
  console.error(`[display] ERROR: ${e.message}`);
  try { await obs.disconnect(); } catch {}
  process.exit(1);
});
