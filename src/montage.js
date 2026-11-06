import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';
import { promises as fsp } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Bundled binaries — no system ffmpeg needed.
const FFMPEG = require('ffmpeg-static');
const FFPROBE = require('ffprobe-static').path;

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

// Prepares approved keepers into web-playable MP4s and manages the venue-montage
// media (clips + uploaded photos) that /montage loops on the venue TVs.
export function makeMontage(cfg) {
  const recDir = cfg.recordings.dir || join(ROOT, 'recordings');
  const approvedDir = join(recDir, cfg.recordings.approvedSubdir);
  const videosDir = join(recDir, 'montage', 'videos');
  const photosDir = join(recDir, 'montage', 'photos');

  let queue = Promise.resolve(); // serialize ffmpeg so we never run two at once

  async function ensureDirs() {
    await fsp.mkdir(videosDir, { recursive: true });
    await fsp.mkdir(photosDir, { recursive: true });
  }

  function run(bin, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(bin, args, { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-500) || `exit ${code}`))));
    });
  }

  async function probeVideoCodec(file) {
    return new Promise((resolve) => {
      const p = spawn(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve(''));
      p.on('close', () => resolve(out.trim()));
    });
  }

  // Build (or refresh) the venue MP4 for one approved keeper. H.264 is stream-
  // copied (instant, low CPU); anything else is re-encoded for browser support.
  // Audio is dropped entirely unless includeAudio is on, in which case track 1
  // (the primary mic) is carried.
  async function prepareClip(mkvPath) {
    const task = queue.then(async () => {
      await ensureDirs();
      const dest = join(videosDir, basename(mkvPath, extname(mkvPath)) + '.mp4');
      // Skip if the MP4 is already newer than its source.
      try {
        const [s, d] = await Promise.all([fsp.stat(mkvPath), fsp.stat(dest)]);
        if (d.mtimeMs >= s.mtimeMs) return dest;
      } catch { /* dest missing -> build it */ }

      const codec = await probeVideoCodec(mkvPath);
      const args = ['-y', '-i', mkvPath, '-map', '0:v:0'];
      args.push('-c:v', codec === 'h264' ? 'copy' : 'libx264');
      if (codec !== 'h264') args.push('-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
      if (cfg.montage.includeAudio) args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '160k');
      else args.push('-an');
      args.push('-movflags', '+faststart', dest);

      const tmp = dest + '.part';
      // Write to a temp name but force the mp4 muxer (the .part extension hides it).
      const finalArgs = args.slice(0, -1).concat(['-f', 'mp4', tmp]);
      await run(FFMPEG, finalArgs);
      await fsp.rename(tmp, dest);
      console.log(`[montage] prepared ${basename(dest)} (${codec === 'h264' ? 'copy' : 're-encode'}, ${cfg.montage.includeAudio ? 'with audio' : 'muted'})`);
      return dest;
    });
    // keep the queue alive even if this task throws
    queue = task.catch(() => {});
    return task;
  }

  // Prepare every approved keeper (used on first setup and after toggling audio).
  async function prepareAll() {
    await ensureDirs();
    let files = [];
    try { files = (await fsp.readdir(approvedDir)).filter((f) => extname(f).toLowerCase() === '.mkv'); } catch { /* none yet */ }
    // Force a rebuild if the audio mode changed: clear stale MP4s first.
    let built = 0;
    for (const f of files) {
      try { await prepareClip(join(approvedDir, f)); built++; } catch (e) { console.error(`[montage] prepare failed for ${f}: ${e.message}`); }
    }
    return { total: files.length, built };
  }

  // When includeAudio is toggled, existing MP4s are wrong — wipe and rebuild.
  async function rebuildAll() {
    await ensureDirs();
    try {
      for (const f of await fsp.readdir(videosDir)) if (extname(f).toLowerCase() === '.mp4') await fsp.unlink(join(videosDir, f)).catch(() => {});
    } catch { /* ignore */ }
    return prepareAll();
  }

  async function listMedia() {
    await ensureDirs();
    const [vids, pics] = await Promise.all([
      fsp.readdir(videosDir).catch(() => []),
      fsp.readdir(photosDir).catch(() => []),
    ]);
    const videos = vids.filter((f) => extname(f).toLowerCase() === '.mp4').sort();
    const photos = pics.filter((f) => IMG_EXT.has(extname(f).toLowerCase())).sort();
    return { videos, photos };
  }

  // Save an uploaded photo: normalize to a downsized JPEG so the montage stays
  // light and every TV can decode it. Returns the stored filename.
  async function savePhoto(buffer, originalName = 'photo') {
    await ensureDirs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = basename(originalName, extname(originalName)).replace(/[^\w-]+/g, '_').slice(0, 40) || 'photo';
    const name = `${stamp}_${safe}.jpg`;
    await sharp(buffer, { failOn: 'none' })
      .rotate() // honor EXIF orientation
      .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(join(photosDir, name));
    console.log(`[montage] photo saved ${name}`);
    return name;
  }

  async function deletePhoto(name) {
    const safe = basename(name); // no path traversal
    await fsp.unlink(join(photosDir, safe));
  }

  // Virtual / non-LAN adapters to skip when guessing the montage host. The ATEM
  // presents a USB-NCM network link (bogus MAC 02:00:00:00:00:00, 172.26.45.x)
  // that the TVs can't reach — it must not win over the real Wi-Fi/Ethernet.
  const VIRTUAL_MAC = new Set(['02:00:00:00:00:00', '00:00:00:00:00:00']);
  const VIRTUAL_NAME = /vethernet|virtualbox|vmware|hyper-?v|loopback|bluetooth|npcap|wsl|default switch|\btap\b|tailscale|zerotier|radmin|hamachi/i;

  // All usable LAN IPv4s, real adapters first, virtual/USB links last.
  function lanCandidates() {
    const out = [];
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const i of list || []) {
        const fam = i.family === 'IPv4' || i.family === 4;
        if (!fam || i.internal || i.address.startsWith('169.254.')) continue;
        const virtual = VIRTUAL_MAC.has((i.mac || '').toLowerCase()) || VIRTUAL_NAME.test(name);
        out.push({ name, address: i.address, virtual });
      }
    }
    out.sort((a, b) => (a.virtual === b.virtual ? 0 : a.virtual ? 1 : -1));
    return out;
  }

  // The LAN IPv4 the TVs should use. config.display.montageHost overrides the
  // auto-pick for venues where detection guesses wrong.
  function lanHost() {
    const override = ((cfg.display && cfg.display.montageHost) || '').trim();
    if (override) return override;
    const c = lanCandidates();
    const best = c.find((x) => !x.virtual) || c[0];
    return best ? best.address : null;
  }

  return { prepareClip, prepareAll, rebuildAll, listMedia, savePhoto, deletePhoto, lanHost, lanCandidates, videosDir, photosDir };
}
