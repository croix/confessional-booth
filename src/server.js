import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'config.json');
const CREST_PATH = join(ROOT, 'public', 'crest.svg');

function crestVersion() {
  try { return Math.floor(statSync(CREST_PATH).mtimeMs); } catch { return 0; }
}

// Tiny HTTP surface. Companion buttons hit the command routes; the /admin app
// hits the /api/* routes to edit branding + prompts for whatever wedding this
// is deployed at.
export function startServer(cfg, booth, montage) {
  const app = express();
  app.use(express.json({ limit: '30mb' })); // photos come in as base64

  const command = (fn) => async (req, res) => {
    try {
      await fn();
      res.json({ ok: true, ...booth.getState() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  };

  app.all('/start', command(() => booth.start()));
  app.all('/stop', command(() => booth.stop()));
  app.all('/startover', command(() => booth.startOver()));
  app.all('/approve', command(() => booth.approve()));
  app.all('/reset', command(() => booth.reset()));

  app.get('/state', (req, res) => res.json(booth.getState()));

  // Branding + prompts for the display (crestVersion lets the display cache-bust
  // the crest image when it changes).
  app.get('/branding', (req, res) =>
    res.json({ ...(cfg.branding || {}), prompts: cfg.prompts || [], crestVersion: crestVersion() }),
  );

  // ---- Admin API (edit config for this wedding) ---------------------------
  app.get('/api/config', (req, res) => {
    res.json({ branding: cfg.branding || {}, prompts: cfg.prompts || [], notify: cfg.notify || {} });
  });

  app.post('/api/config', (req, res) => {
    try {
      const { branding, prompts, notify } = req.body || {};
      if (branding && typeof branding !== 'object') throw new Error('branding must be an object');
      if (prompts && !Array.isArray(prompts)) throw new Error('prompts must be a list');
      if (notify && typeof notify !== 'object') throw new Error('notify must be an object');
      if (notify && notify.url && !/^https?:\/\//i.test(notify.url))
        throw new Error('notify url must start with http:// or https://');
      const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      if (branding) saved.branding = branding;
      if (prompts) saved.prompts = prompts;
      if (notify) saved.notify = { ...(saved.notify || {}), ...notify };
      writeFileSync(CONFIG_PATH, JSON.stringify(saved, null, 2) + '\n');
      // apply in-memory so the live display + notifier pick it up right away
      if (branding) cfg.branding = branding;
      if (prompts) cfg.prompts = prompts;
      if (notify) cfg.notify = { ...(cfg.notify || {}), ...notify };
      console.log('[admin] config saved');
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Fire a test alert through the current notify webhook so the operator can
  // confirm their phone is subscribed and receiving.
  app.post('/api/test-notify', async (req, res) => {
    try {
      await booth.notify('Test alert from the booth admin — notifications are working. 🔔');
      res.json({ ok: true, url: cfg.notify && cfg.notify.url ? cfg.notify.url : '' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Rebuild the Stream Deck (re-render crest + regenerate layout + restart
  // Companion) by running the bundled PowerShell script. Localhost-only.
  let rebuildRunning = false;
  app.post('/api/rebuild-deck', (req, res) => {
    if (rebuildRunning) return res.status(409).json({ ok: false, error: 'a rebuild is already running' });
    rebuildRunning = true;
    const script = join(ROOT, 'Rebuild-Deck.ps1');
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.on('data', (d) => (out += d));
    ps.on('error', (e) => { rebuildRunning = false; if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); });
    ps.on('close', (code) => {
      rebuildRunning = false;
      console.log(`[admin] rebuild-deck exited ${code}`);
      if (res.headersSent) return;
      if (code === 0) res.json({ ok: true, log: out.slice(-1500) });
      else res.status(500).json({ ok: false, error: `rebuild exited ${code}`, log: out.slice(-1500) });
    });
  });

  // ---- Venue montage ------------------------------------------------------
  // Media served to the venue TVs.
  if (montage) {
    app.use('/montage-media/videos', express.static(montage.videosDir, { maxAge: '1h' }));
    app.use('/montage-media/photos', express.static(montage.photosDir, { maxAge: '1h' }));
  }

  app.get('/montage', (req, res) => res.sendFile(join(ROOT, 'public', 'montage.html')));

  // Everything the montage page needs: settings, branding and the current media.
  app.get('/api/montage', async (req, res) => {
    try {
      const { videos, photos } = montage ? await montage.listMedia() : { videos: [], photos: [] };
      res.json({
        settings: cfg.montage || {},
        branding: cfg.branding || {},
        crestVersion: crestVersion(),
        videos: videos.map((f) => '/montage-media/videos/' + encodeURIComponent(f)),
        photos: photos.map((f) => ({ name: f, url: '/montage-media/photos/' + encodeURIComponent(f) })),
        lanUrl: montage && montage.lanHost() ? `http://${montage.lanHost()}:${cfg.server.port}/montage` : null,
        // all reachable LAN IPs (real adapters first) so the admin can offer a
        // pick if auto-detect guesses wrong (e.g. multiple networks).
        lanCandidates: montage ? montage.lanCandidates().map((c) => ({ ...c, url: `http://${c.address}:${cfg.server.port}/montage` })) : [],
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/montage/settings', async (req, res) => {
    try {
      const s = req.body || {};
      const clean = {
        enabled: !!s.enabled,
        includeAudio: !!s.includeAudio,
        photoSeconds: Math.min(60, Math.max(2, Number(s.photoSeconds) || 7)),
        videoGapPhotos: Math.min(5, Math.max(0, Number(s.videoGapPhotos) || 0)),
        shuffle: !!s.shuffle,
      };
      const audioChanged = (cfg.montage || {}).includeAudio !== clean.includeAudio;
      const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      saved.montage = clean;
      writeFileSync(CONFIG_PATH, JSON.stringify(saved, null, 2) + '\n');
      cfg.montage = clean;
      console.log('[montage] settings saved');
      // Flipping the audio mode invalidates the prepared clips — rebuild them.
      if (audioChanged && montage) montage.rebuildAll().catch((e) => console.error(`[montage] rebuild: ${e.message}`));
      res.json({ ok: true, rebuilding: audioChanged });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Re-prepare every keeper (e.g. first-time setup for already-approved takes).
  app.post('/api/montage/rebuild', async (req, res) => {
    try {
      const r = await montage.prepareAll();
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/montage/photo', async (req, res) => {
    try {
      const { dataUrl, name } = req.body || {};
      if (typeof dataUrl !== 'string') throw new Error('expected an image');
      const m = dataUrl.match(/^data:image\/[\w.+-]+;base64,(.+)$/i);
      if (!m) throw new Error('expected a base64 image data URL');
      const buf = Buffer.from(m[1], 'base64');
      const saved = await montage.savePhoto(buf, name || 'photo');
      res.json({ ok: true, name: saved, url: '/montage-media/photos/' + encodeURIComponent(saved) });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/montage/photo/delete', async (req, res) => {
    try {
      const { name } = req.body || {};
      if (!name) throw new Error('name required');
      await montage.deletePhoto(name);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/crest', (req, res) => {
    try {
      const { svg } = req.body || {};
      if (typeof svg !== 'string' || !/<svg[\s>]/i.test(svg)) throw new Error('expected an SVG file');
      writeFileSync(CREST_PATH, svg);
      console.log('[admin] crest updated');
      res.json({ ok: true, crestVersion: crestVersion() });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Admin page + the full-screen booth display, both from public/.
  app.get('/admin', (req, res) => res.sendFile(join(ROOT, 'public', 'admin.html')));
  app.use('/display', express.static(join(ROOT, 'public')));

  app.get('/', (req, res) =>
    res
      .type('text')
      .send(
        `Confessional Booth controller\n` +
          `state:  ${booth.state}\n` +
          `status: ${booth.status}\n` +
          `last:   ${booth.lastFile || '-'}\n` +
          `admin:  http://${cfg.server.host}:${cfg.server.port}/admin\n`,
      ),
  );

  return app.listen(cfg.server.port, cfg.server.host, () =>
    console.log(`[server] listening on http://${cfg.server.host}:${cfg.server.port}  (admin at /admin)`),
  );
}
