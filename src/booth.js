import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import { dirname, join, basename } from 'node:path';

// States the guest flows through. STOPPING is a brief internal state that blocks
// re-entry while an async StopRecord is in flight.
export const S = {
  READY: 'READY',
  COUNTDOWN: 'COUNTDOWN',
  RECORDING: 'RECORDING',
  STOPPING: 'STOPPING',
  REVIEW: 'REVIEW',
  THANKS: 'THANKS',
};

export class Booth extends EventEmitter {
  constructor(cfg, obs, notify, setVar) {
    super();
    this.cfg = cfg;
    this.obs = obs;
    this.notify = notify;
    this.setVar = setVar;

    this.state = S.READY;
    this.status = 'Starting…';
    this.lastFile = null;
    this.currentPrompt = null;
    this.countdown = null; // live countdown number, for the branded display
    this._lastPromptIndex = -1;
    this._started = false;

    this.timer = null; // primary per-state timeout
    this.countdownInterval = null;
    this.attractTimer = null;
  }

  log(msg) {
    console.log(`[booth ${new Date().toISOString()}] ${msg}`);
  }

  getState() {
    return {
      state: this.state,
      status: this.status,
      lastFile: this.lastFile,
      prompt: this.currentPrompt,
      countdown: this.countdown,
    };
  }

  // ---- lifecycle hooks from the OBS connection ----------------------------

  onObsReady() {
    if (!this._started) {
      this._started = true;
      this._enterReady();
      return;
    }
    // Reconnected mid-session: re-assert the scene for wherever we are.
    const scene = this._sceneFor(this.state);
    if (scene) this.obs.setScene(scene).catch((e) => this._obsError(e));
    this._pushState(this.status);
  }

  onObsClosed() {
    this.notify('OBS websocket disconnected — the booth is not recording.', 'obs');
  }

  // ---- commands (from HTTP / Companion) -----------------------------------

  start() {
    if (this.state !== S.READY) return this._ignored('start');
    this._enterCountdown();
  }

  async stop() {
    if (this.state !== S.RECORDING) return this._ignored('stop');
    this.state = S.STOPPING; // block a double-stop during the await
    this._clearTimers();
    this._pushState('Saving…');
    let path;
    try {
      path = await this.obs.stopRecord();
    } catch (e) {
      this._obsError(e, 'Could not stop recording');
      return this._enterReady();
    }
    if (!path) {
      this.notify('Recording stopped but OBS returned no file path.', 'file');
      return this._enterReady();
    }
    this._enterReview(path);
  }

  async startOver() {
    if (this.state === S.COUNTDOWN) return this._enterReady();
    if (this.state === S.REVIEW) {
      const file = this.lastFile;
      this.lastFile = null;
      this._archiveBlooper(file, true); // still loaded in the review source
      return this._enterCountdown();
    }
    if (this.state === S.RECORDING) {
      this.state = S.STOPPING;
      this._clearTimers();
      let path;
      try {
        path = await this.obs.stopRecord();
      } catch (e) {
        this._obsError(e);
      }
      if (path) this._archiveBlooper(path, false); // not in the review source yet
      return this._enterCountdown();
    }
    return this._ignored('startover');
  }

  approve() {
    if (this.state !== S.REVIEW) return this._ignored('approve');
    const file = this.lastFile;
    this.lastFile = null;
    this._enterThanks();
    this._releaseAndArchive(file); // release OBS's file lock, then archive
  }

  async reset() {
    this._clearTimers();
    const wasReview = this.state === S.REVIEW;
    let file = wasReview ? this.lastFile : null;
    if (this.state === S.RECORDING || this.state === S.STOPPING) {
      try {
        const p = await this.obs.stopRecord();
        if (p) file = p;
      } catch {
        /* may not be recording; ignore */
      }
    }
    this.lastFile = null;
    if (file) this._archiveBlooper(file, wasReview); // keep any in-flight take
    this._enterReady();
  }

  // ---- state transitions --------------------------------------------------

  _enterReady() {
    this._clearTimers();
    this.state = S.READY;
    this.currentPrompt = null;
    this.countdown = null;
    this.setVar('booth_countdown', '');
    this._pushState('Ready — press START');
    this.obs.setScene(this.cfg.scenes.ready).catch((e) => this._obsError(e));
    // After a while idle, swap to the attract screen to invite the next guest.
    this.attractTimer = setTimeout(() => {
      this.log('idle -> attract screen');
      this.obs.setScene(this.cfg.scenes.attract).catch(() => {});
    }, this.cfg.timings.attractAfterSeconds * 1000);
  }

  _enterCountdown() {
    this._clearTimers();
    this.state = S.COUNTDOWN;
    const prompt = this._pickPrompt();
    this.currentPrompt = prompt;
    this._pushState('Get ready…');

    let n = this.cfg.timings.countdownSeconds;
    this.countdown = n;
    Promise.all([
      this.obs.setText(this.cfg.sources.promptText, prompt),
      this.obs.setText(this.cfg.sources.countdownText, String(n)),
      this.obs.setScene(this.cfg.scenes.countdown),
    ]).catch((e) => this._obsError(e));
    this.setVar('booth_countdown', n);

    this.countdownInterval = setInterval(() => {
      n -= 1;
      this.countdown = n;
      if (n > 0) {
        this.obs.setText(this.cfg.sources.countdownText, String(n)).catch(() => {});
        this.setVar('booth_countdown', n);
      } else {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
        this.setVar('booth_countdown', 0);
        this._enterRecording();
      }
    }, 1000);
  }

  async _enterRecording() {
    this._clearTimers();
    this.state = S.RECORDING;
    this.countdown = null;
    this._pushState('Recording — pause, then press STOP');
    try {
      // Switch to the clean camera scene BEFORE recording starts, and let any
      // scene transition finish, so the countdown overlay never lands in the
      // first frames of the file.
      await this.obs.setScene(this.cfg.scenes.recording);
      await new Promise((r) => setTimeout(r, this.cfg.timings.recordStartDelayMs));
      await this.obs.startRecord();
    } catch (e) {
      this._obsError(e, 'Could not start recording');
      return this._enterReady();
    }
    // Safety: if nobody ever presses STOP, end the take ourselves.
    this.timer = setTimeout(() => {
      this.log('max record length reached — auto-stopping');
      this.stop();
    }, this.cfg.timings.maxRecordSeconds * 1000);
  }

  async _enterReview(file) {
    this._clearTimers();
    this.state = S.REVIEW;
    this.lastFile = file;
    this._pushState('Review — APPROVE or START OVER');
    this.log(`review take: ${file}`);
    // StopRecord returns the path immediately, but OBS is still flushing the
    // container. If we point the review Media Source at it too early it opens a
    // zero-duration file and shows black forever. Wait for the file to finish
    // writing (size stops growing) before loading it. We hold on the RECORDING
    // scene during this brief wait so the guest never sees a black flash.
    await this._waitForFileReady(file);
    try {
      await this.obs.setMedia(this.cfg.sources.reviewMedia, file);
      await this.obs.setScene(this.cfg.scenes.review);
      await this.obs.restartMedia(this.cfg.sources.reviewMedia);
    } catch (e) {
      this._obsError(e);
    }
    // Walk-away safety: keep the take as a blooper (never delete), reset for
    // the next guest.
    this.timer = setTimeout(() => {
      this.log('review timeout — walk-away, filing take as a blooper');
      const file = this.lastFile;
      this.lastFile = null;
      this._archiveBlooper(file, true);
      this._enterReady();
    }, this.cfg.timings.reviewTimeoutSeconds * 1000);
  }

  _enterThanks() {
    this._clearTimers();
    this.state = S.THANKS;
    this._pushState('Thank you!');
    this.obs.setScene(this.cfg.scenes.thanks).catch((e) => this._obsError(e));
    this.timer = setTimeout(() => this._enterReady(), this.cfg.timings.thanksSeconds * 1000);
  }

  // ---- helpers ------------------------------------------------------------

  // Release OBS's handle on the review file (it keeps it open, and Windows locks
  // open files), then archive the approved take.
  async _releaseAndArchive(file) {
    if (!file) return;
    try {
      await this.obs.setMedia(this.cfg.sources.reviewMedia, '');
    } catch (e) {
      this._obsError(e);
    }
    await this._archiveApproved(file);
  }

  // File a non-approved take (start-over / walk-away / reset) into the bloopers
  // folder. Never deletes. If it's still loaded in the review source, release
  // OBS's handle first so the move isn't blocked.
  async _archiveBlooper(file, heldByReview) {
    if (!file) return;
    if (heldByReview) {
      try {
        await this.obs.setMedia(this.cfg.sources.reviewMedia, '');
      } catch (e) {
        this._obsError(e);
      }
    }
    // A take cancelled mid-recording may still be finalizing on disk; wait for
    // it to finish writing before moving so the move can't miss the file.
    await this._waitForFileReady(file);
    try {
      const dir = join(dirname(file), this.cfg.recordings.bloopersSubdir);
      await fsp.mkdir(dir, { recursive: true });
      const dest = join(dir, basename(file));
      await this._moveWithRetry(file, dest);
      this.log(`blooper kept -> ${dest}`);
    } catch (e) {
      this.notify(`Failed to file blooper: ${e.message}`, 'blooper');
    }
  }

  async _archiveApproved(file) {
    if (!file) return;
    try {
      const approvedDir = join(dirname(file), this.cfg.recordings.approvedSubdir);
      await fsp.mkdir(approvedDir, { recursive: true });
      const dest = join(approvedDir, basename(file));
      await this._moveWithRetry(file, dest);
      this.log(`approved take archived -> ${dest}`);
    } catch (e) {
      this.notify(`Failed to archive approved take: ${e.message}`, 'archive');
    }
  }

  // Move a file, tolerating OBS briefly still holding the handle (EBUSY/EPERM)
  // and cross-volume moves (EXDEV).
  async _moveWithRetry(src, dest, attempts = 10) {
    for (let i = 0; i < attempts; i++) {
      try {
        await fsp.rename(src, dest);
        return;
      } catch (e) {
        if (e.code === 'EXDEV') {
          await fsp.copyFile(src, dest);
          await fsp.unlink(src);
          return;
        }
        if ((e.code === 'EBUSY' || e.code === 'EPERM') && i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        throw e;
      }
    }
  }

  // Poll the just-recorded file until it stops growing (OBS has finished
  // finalizing the container), so review playback opens a complete file.
  // Resolves early once the size is stable; gives up after timeoutMs and
  // loads anyway rather than hanging the flow.
  async _waitForFileReady(file, { timeoutMs = 6000, stableMs = 400, pollMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastSize = -1;
    let stableSince = 0;
    while (Date.now() < deadline) {
      let size = 0;
      try {
        size = (await fsp.stat(file)).size;
      } catch {
        size = 0; // not visible yet
      }
      if (size > 0 && size === lastSize) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return true;
      } else {
        stableSince = 0;
      }
      lastSize = size;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    this.log(`review file never stabilized in ${timeoutMs}ms; loading anyway`);
    return false;
  }

  _pickPrompt() {
    const list = this.cfg.prompts;
    if (!list || list.length === 0) return '';
    if (list.length === 1) return list[0];
    let i;
    do {
      i = Math.floor(Math.random() * list.length);
    } while (i === this._lastPromptIndex);
    this._lastPromptIndex = i;
    return list[i];
  }

  _sceneFor(state) {
    return {
      [S.READY]: this.cfg.scenes.ready,
      [S.COUNTDOWN]: this.cfg.scenes.countdown,
      [S.RECORDING]: this.cfg.scenes.recording,
      [S.REVIEW]: this.cfg.scenes.review,
      [S.THANKS]: this.cfg.scenes.thanks,
    }[state];
  }

  _clearTimers() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    if (this.attractTimer) {
      clearTimeout(this.attractTimer);
      this.attractTimer = null;
    }
  }

  _pushState(status) {
    this.status = status;
    this.setVar('booth_state', this.state);
    this.setVar('booth_status', status);
    this.emit('state', this.getState());
    this.log(`state -> ${this.state} (${status})`);
  }

  _ignored(cmd) {
    this.log(`ignored '${cmd}' in state ${this.state}`);
  }

  _obsError(e, context) {
    this.notify(`${context || 'OBS error'}: ${e.message}`, 'obs');
  }
}
