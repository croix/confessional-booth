// Bootstrap OBS for the confessional booth over obs-websocket.
//
// Creates an ISOLATED profile + scene collection named "ConfessionalBooth" so
// it never touches your other OBS setups, then builds the exact scenes and
// sources the controller drives (names come from config.json). Idempotent-ish:
// safe to re-run; it recreates the scene collection from scratch.
//
//   node scripts/bootstrap-obs.mjs
//
// Requires: OBS running with the WebSocket server enabled (Tools > WebSocket
// Server Settings) and the password/port matching config.json.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import OBSWebSocket from 'obs-websocket-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'ConfessionalBooth';

function loadConfig() {
  const p = join(ROOT, 'config.json');
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  cfg.obs ??= { url: 'ws://127.0.0.1:4455', password: '' };
  return cfg;
}

const cfg = loadConfig();
const S = cfg.scenes;
const SRC = cfg.sources;

const recordDir = resolve(ROOT, 'recordings');
mkdirSync(recordDir, { recursive: true });

const obs = new OBSWebSocket();

// Pick a concrete input kind from what this OBS build actually offers.
let KINDS = [];
function kindFor(...prefixes) {
  for (const pre of prefixes) {
    const hit = KINDS.find((k) => k.startsWith(pre));
    if (hit) return hit;
  }
  return null;
}

async function req(type, data) {
  try {
    return await obs.call(type, data);
  } catch (e) {
    throw new Error(`${type} failed: ${e.message}`);
  }
}

async function ensureProfile() {
  const { profiles, currentProfileName } = await req('GetProfileList');
  if (!profiles.includes(NAME)) {
    // CreateProfile auto-activates the new profile.
    await req('CreateProfile', { profileName: NAME });
    console.log(`[bootstrap] created profile ${NAME}`);
  } else if (currentProfileName !== NAME) {
    // SetCurrentProfile errors if the target is already active, so only switch
    // when we actually need to.
    await req('SetCurrentProfile', { profileName: NAME });
  }
  console.log(`[bootstrap] active profile -> ${NAME}`);
  try {
    await req('SetRecordDirectory', { recordDirectory: recordDir });
    console.log(`[bootstrap] record directory -> ${recordDir}`);
  } catch (e) {
    console.warn(`[bootstrap] could not set record dir automatically (${e.message}); set it in OBS > Settings > Output. Wanted: ${recordDir}`);
  }
}

async function freshSceneCollection() {
  const { sceneCollections } = await req('GetSceneCollectionList');
  // Create (or re-create) a clean collection. If it already exists we make a
  // uniquely-named one and switch to it, so re-runs don't error.
  let target = NAME;
  if (sceneCollections.includes(NAME)) {
    target = `${NAME}_${Date.now().toString().slice(-5)}`;
  }
  await req('CreateSceneCollection', { sceneCollectionName: target });
  console.log(`[bootstrap] created + switched to scene collection ${target}`);
  // Switching collections reloads OBS state; give it a beat.
  await new Promise((r) => setTimeout(r, 800));
}

async function addColor(scene, name) {
  await req('CreateInput', {
    sceneName: scene,
    inputName: name,
    inputKind: kindFor('color_source'),
    inputSettings: { color: 0xff1a1a2e, width: 1920, height: 1080 },
    sceneItemEnabled: true,
  });
}

async function addExisting(scene, sourceName) {
  await req('CreateSceneItem', { sceneName: scene, sourceName, sceneItemEnabled: true });
}

async function addText(scene, name, text, big = false) {
  await req('CreateInput', {
    sceneName: scene,
    inputName: name,
    inputKind: kindFor('text_gdiplus', 'text_ft2_source', 'text'),
    inputSettings: {
      text,
      font: { face: 'Arial', size: big ? 300 : 48, style: 'Bold' },
    },
    sceneItemEnabled: true,
  });
}

async function main() {
  console.log(`[bootstrap] connecting to ${cfg.obs.url} ...`);
  await obs.connect(cfg.obs.url, cfg.obs.password || undefined);
  const kl = await req('GetInputKindList');
  KINDS = kl.inputKinds;
  console.log(`[bootstrap] connected. ${KINDS.length} input kinds available.`);
  if (!kindFor('color_source')) throw new Error('no color source kind found');
  if (!kindFor('text_gdiplus', 'text_ft2_source', 'text')) throw new Error('no text source kind found');
  if (!kindFor('ffmpeg_source', 'vlc_source')) console.warn('[bootstrap] no media source kind found; REVIEW playback may not work');

  await ensureProfile();
  await freshSceneCollection();

  // Create all scenes.
  const scenes = [S.ready, S.attract, S.countdown, S.recording, S.review, S.thanks];
  for (const s of scenes) {
    await req('CreateScene', { sceneName: s });
    console.log(`[bootstrap] scene: ${s}`);
  }

  // Camera stand-in (a color source; swap for your ATEM capture device later).
  // Created in READY, then referenced into the other live scenes.
  await addColor(S.ready, SRC.camera);
  for (const s of [S.attract, S.countdown, S.recording]) await addExisting(s, SRC.camera);
  console.log(`[bootstrap] camera source "${SRC.camera}" placed in live scenes`);

  // Instruction labels (nice on the booth monitor; not required by controller).
  await addText(S.ready, 'txt_ready', 'Get settled in frame,\nthen press START');
  await addText(S.attract, 'txt_attract', 'Leave a message for the couple \u{1F48D}\nPress START');
  await addText(S.thanks, 'txt_thanks', 'Thank you! \u{1F495}');

  // Functional text sources the controller writes to.
  await addText(S.countdown, SRC.countdownText, '3', true);
  await addText(S.countdown, SRC.promptText, 'Your question appears here');
  await addExisting(S.recording, SRC.promptText);
  await addText(S.recording, 'txt_rec', '● REC   When done, pause then press STOP');
  console.log('[bootstrap] text sources created');

  // Review media source (controller points it at the just-recorded file).
  await req('CreateInput', {
    sceneName: S.review,
    inputName: SRC.reviewMedia,
    inputKind: kindFor('ffmpeg_source', 'vlc_source'),
    inputSettings: { is_local_file: true, local_file: '', looping: true },
    sceneItemEnabled: true,
  });
  await addText(S.review, 'txt_review', 'Like it?  APPROVE  or  START OVER');
  console.log(`[bootstrap] review media source "${SRC.reviewMedia}" created`);

  // Land on READY, then drop the empty default scene OBS created with the collection.
  await req('SetCurrentProgramScene', { sceneName: S.ready });
  try {
    const { scenes: existing } = await req('GetSceneList');
    for (const sc of existing) {
      const nm = sc.sceneName;
      if (!scenes.includes(nm)) {
        await req('RemoveScene', { sceneName: nm });
        console.log(`[bootstrap] removed default scene "${nm}"`);
      }
    }
  } catch (e) {
    console.warn(`[bootstrap] could not prune default scene: ${e.message}`);
  }

  console.log('\n[bootstrap] DONE. OBS is ready for the controller.');
  console.log(`[bootstrap] recordings will be written to: ${recordDir}`);
  await obs.disconnect();
}

main().catch(async (e) => {
  console.error(`[bootstrap] ERROR: ${e.message}`);
  try { await obs.disconnect(); } catch {}
  process.exit(1);
});
