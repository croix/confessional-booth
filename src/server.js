import express from 'express';

// Tiny HTTP surface. Companion buttons hit these; commands accept GET or POST so
// either Companion HTTP action works. State-changing routes are guarded inside
// the Booth (invalid commands for the current state are simply ignored).
export function startServer(cfg, booth) {
  const app = express();

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
  app.get('/', (req, res) =>
    res
      .type('text')
      .send(
        `Confessional Booth controller\n` +
          `state:  ${booth.state}\n` +
          `status: ${booth.status}\n` +
          `last:   ${booth.lastFile || '-'}\n`,
      ),
  );

  return app.listen(cfg.server.port, cfg.server.host, () =>
    console.log(`[server] listening on http://${cfg.server.host}:${cfg.server.port}`),
  );
}
