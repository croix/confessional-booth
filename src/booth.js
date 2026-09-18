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
    return { state: this.state, status: this.status, lastFile: this.lastFile };
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
      this.lastFile = null; // stays on disk as a blooper, just no longer "current"
      return this._enterCountdown();
    }
    if (this.state === S.RECORDING) {
      this.state = S.STOPPING;
      this._clearTimers();
      try {
        await this.obs.stopRecord(); // kept as a blooper, not archived
      } catch (e) {
        this._obsError(e);
      }
      return this._enterCountdown();
    }
    return this._ignored('startover');
  }

  approve() {
    if (this.state !== S.REVIEW) return this._ignored('approve');
    const file = this.lastFile;
    this.lastFile = null;
    this._archiveApproved(file); // async, self-contained error handling
    this._enterThanks();
  }

  async reset() {
    this._clearTimers();
    if (this.state === S.RECORDING || this.state === S.STOPPING) {
      try {
        await this.obs.stopRecord();
      } catch {
        /* may not be recording; ignore */
      }
    }
    this.lastFile = null;
    this._enterReady();
  }

  // ---- state transitions --------------------------------------------------

  _enterReady() {
    this._clearTimers();
    this.state = S.READY;
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
    Promise.all([
      this.obs.setText(this.cfg.sources.promptText, prompt),
      this.obs.setText(this.cfg.sources.countdownText, String(n)),
      this.obs.setScene(this.cfg.scenes.countdown),
    ]).catch((e) => this._obsError(e));
    this.setVar('booth_countdown', n);

    this.countdownInterval = setInterval(() => {
      n -= 1;
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
    this._pushState('Recording — pause, then press STOP');
    try {
      await this.obs.startRecord();
    } catch (e) {
      this._obsError(e, 'Could not start recording');
      return this._enterReady();
    }
    this.obs.setScene(this.cfg.scenes.recording).catch((e) => this._obsError(e));
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
    try {
      await this.obs.setMedia(this.cfg.sources.reviewMedia, file);
      await this.obs.setScene(this.cfg.scenes.review);
      await this.obs.restartMedia(this.cfg.sources.reviewMedia);
    } catch (e) {
      this._obsError(e);
    }
    // Walk-away safety: keep the take (don't delete), reset for the next guest.
    this.timer = setTimeout(() => {
      this.log('review timeout — keeping take, returning to ready');
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

  async _archiveApproved(file) {
    if (!file) return;
    try {
      const approvedDir = join(dirname(file), this.cfg.recordings.approvedSubdir);
      await fsp.mkdir(approvedDir, { recursive: true });
      const dest = join(approvedDir, basename(file));
      try {
        await fsp.rename(file, dest);
      } catch (e) {
        if (e.code === 'EXDEV') {
          // Different volume: copy then remove.
          await fsp.copyFile(file, dest);
          await fsp.unlink(file);
        } else {
          throw e;
        }
      }
      this.log(`approved take archived -> ${dest}`);
    } catch (e) {
      this.notify(`Failed to archive approved take: ${e.message}`, 'archive');
    }
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
