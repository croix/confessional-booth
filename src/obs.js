import { EventEmitter } from 'node:events';
import OBSWebSocket from 'obs-websocket-js';
import jpeg from 'jpeg-js';

// Thin wrapper around obs-websocket-js: auto-reconnect + the handful of
// calls the booth needs. Emits 'open' on (re)connect and 'close' on drop.
export class OBS extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.connected = false;
    this._stopped = false;
    this._reconnectTimer = null;
    this.ws = new OBSWebSocket();
    this.ws.on('ConnectionClosed', () => {
      if (this.connected) {
        this.connected = false;
        this.emit('close');
      }
      this._scheduleReconnect();
    });
  }

  connect() {
    this._stopped = false;
    this._tryConnect();
  }

  async _tryConnect() {
    try {
      await this.ws.connect(this.cfg.obs.url, this.cfg.obs.password || undefined);
      this.connected = true;
      console.log('[obs] connected');
      this.emit('open');
    } catch (e) {
      this.connected = false;
      console.error(`[obs] connect failed: ${e.message}; retrying in 3s`);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._tryConnect(), 3000);
  }

  call(type, data) {
    return this.ws.call(type, data);
  }

  setScene(sceneName) {
    return this.call('SetCurrentProgramScene', { sceneName });
  }

  startRecord() {
    return this.call('StartRecord');
  }

  // Returns the absolute path of the file just written.
  async stopRecord() {
    const res = await this.call('StopRecord');
    return res.outputPath;
  }

  getRecordStatus() {
    return this.call('GetRecordStatus');
  }

  setText(inputName, text) {
    return this.call('SetInputSettings', {
      inputName,
      inputSettings: { text: String(text) },
      overlay: true,
    });
  }

  // Point the review Media Source at a file (looping so guests can rewatch).
  setMedia(inputName, filePath) {
    return this.call('SetInputSettings', {
      inputName,
      inputSettings: {
        local_file: filePath,
        is_local_file: true,
        looping: true,
        restart_on_activate: true,
      },
      overlay: true,
    });
  }

  restartMedia(inputName) {
    return this.call('TriggerMediaInputAction', {
      inputName,
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    });
  }

  // Grab a tiny screenshot of a source and return its average brightness
  // (0-255). Used by the watchdog to catch a dead/black camera feed.
  async screenshotBrightness(sourceName) {
    const res = await this.call('GetSourceScreenshot', {
      sourceName,
      imageFormat: 'jpg',
      imageWidth: 64,
      imageHeight: 36,
      imageCompressionQuality: 50,
    });
    const b64 = res.imageData.split(',')[1];
    const img = jpeg.decode(Buffer.from(b64, 'base64'), { useTArray: true });
    const d = img.data; // RGBA
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += d[i] + d[i + 1] + d[i + 2];
    }
    return sum / ((d.length / 4) * 3);
  }
}
