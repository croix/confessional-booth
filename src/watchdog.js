import { S } from './booth.js';

// Unattended safety net. Every interval it checks two things and pushes a phone
// alert if either looks wrong:
//   1. While RECORDING, the output file should be growing.
//   2. While a live-camera scene is up, the feed shouldn't be black
//      (catches the A7III sleeping / overheating / a yanked micro-HDMI).
export function startWatchdog(cfg, obs, booth) {
  const cameraStates = new Set([S.READY, S.COUNTDOWN, S.RECORDING]);
  let lastBytes = -1;
  let blackStrikes = 0;

  const timer = setInterval(async () => {
    if (!obs.connected) return;
    try {
      // 1. Recording actually writing?
      if (booth.state === S.RECORDING) {
        const st = await obs.getRecordStatus();
        if (!st.outputActive) {
          booth.notify('Expected a recording to be active, but OBS is not recording.', 'stall');
        } else if (lastBytes >= 0 && st.outputBytes <= lastBytes) {
          booth.notify('Recording appears stalled — the file is not growing.', 'stall');
        }
        lastBytes = st.outputBytes;
      } else {
        lastBytes = -1;
      }

      // 2. Camera feed alive?
      if (cameraStates.has(booth.state)) {
        const brightness = await obs.screenshotBrightness(cfg.sources.camera);
        if (brightness < cfg.watchdog.blackThreshold) {
          blackStrikes += 1;
          if (blackStrikes >= cfg.watchdog.blackStrikes) {
            booth.notify(
              `Camera feed looks black (brightness ${brightness.toFixed(1)}). Check the A7III power/HDMI.`,
              'black',
            );
          }
        } else {
          blackStrikes = 0;
        }
      } else {
        blackStrikes = 0;
      }
    } catch {
      // Transient (e.g. source briefly gone during a scene switch); ignore.
    }
  }, cfg.watchdog.intervalSeconds * 1000);

  return () => clearInterval(timer);
}
