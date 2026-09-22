import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Baked-in defaults. Anything in config.json (same shape) overrides these,
// so the controller runs even with no config file — see config.example.json.
const DEFAULTS = {
  obs: {
    url: 'ws://127.0.0.1:4455',
    password: '', // OBS: Tools > WebSocket Server Settings
  },
  companion: {
    // Companion's HTTP API. Enable it in Companion > Settings, note the port.
    baseUrl: 'http://127.0.0.1:8000',
  },
  server: {
    host: '127.0.0.1',
    port: 3939,
  },
  recordings: {
    // Approved ("keeper") takes move into this subfolder; everything else that
    // was recorded (start-over / walk-away takes) moves into bloopersSubdir.
    // Nothing is ever deleted.
    approvedSubdir: 'approved',
    bloopersSubdir: 'bloopers',
  },
  // These names MUST match the scene/source names you create in OBS.
  scenes: {
    ready: 'READY',
    attract: 'ATTRACT',
    countdown: 'COUNTDOWN',
    recording: 'RECORDING',
    review: 'REVIEW',
    thanks: 'THANKS',
  },
  sources: {
    camera: 'Camera', // the ATEM USB Video Capture Device
    countdownText: 'txt_countdown',
    promptText: 'txt_prompt',
    reviewMedia: 'mediaReview', // a Media Source on the REVIEW scene
  },
  timings: {
    countdownSeconds: 3,
    maxRecordSeconds: 240, // safety auto-stop if nobody presses STOP
    reviewTimeoutSeconds: 90, // walk-away in review -> keep take, go READY
    thanksSeconds: 4,
    attractAfterSeconds: 120, // idle in READY -> swap to the ATTRACT scene
  },
  prompts: [
    'How did you meet the happy couple?',
    "What's your favorite memory with them?",
    'What advice would you give them for a happy marriage?',
    "Tell us a story about the couple they'd rather we forget.",
    'When did you know these two were meant to be?',
    'Describe the couple in three words.',
    'What do you love most about them together?',
    'Share one wish for their future.',
    "What's the funniest thing you've seen them do?",
    "Raise a toast — what would you say?",
    'What song will always remind you of them?',
  ],
  watchdog: {
    intervalSeconds: 10,
    blackThreshold: 12, // avg brightness (0-255) below this = probably no signal
    blackStrikes: 3, // consecutive black checks before alerting
  },
  notify: {
    url: '', // e.g. https://ntfy.sh/your-secret-topic — empty = log only
    title: 'Confessional Booth',
    cooldownSeconds: 120, // don't spam the same alert
  },
  // Cosmetic branding for the full-screen display (public/index.html, served at
  // /display). Override any of these in config.json.
  branding: {
    coupleNames: 'Alex & Jordan',
    weddingDate: 'the twelfth of June, two thousand twenty-seven',
    monogram: 'A J',
    hashtag: '#AlexAndJordan',
    invite: 'Leave a message for the newlyweds',
    promptIntro: 'Need an idea? Try one of these',
    freeform: '…or record any message you like',
    thanksMessage: 'Your message means the world to us',
    palette: {
      bg: '#12100e',
      panel: '#1b1813',
      ink: '#f7f2e9',
      muted: '#c9bda8',
      gold: '#c9a961',
      accent: '#7c6a52',
    },
    headingFont: 'Cormorant Garamond',
    bodyFont: 'Montserrat',
  },
};

function mergeSection(def, override) {
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    return { ...def, ...override };
  }
  return override !== undefined ? override : def;
}

export function loadConfig() {
  let user = {};
  const p = join(ROOT, 'config.json');
  if (existsSync(p)) {
    try {
      user = JSON.parse(readFileSync(p, 'utf8'));
      console.log('[config] loaded config.json');
    } catch (e) {
      console.error(`[config] config.json is invalid, using defaults: ${e.message}`);
    }
  } else {
    console.log('[config] no config.json found, using built-in defaults');
  }
  const cfg = {};
  for (const key of Object.keys(DEFAULTS)) {
    cfg[key] = mergeSection(DEFAULTS[key], user[key]);
  }
  return cfg;
}
