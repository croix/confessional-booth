# Confessional Booth Controller

Unattended wedding confessional booth. A small Node service owns the state
machine (READY → COUNTDOWN → RECORDING → REVIEW → APPROVE), drives **OBS** over
`obs-websocket`, and **Bitfocus Companion** drives the Stream Deck by firing
HTTP commands at this service and reflecting its state on the keys.

```
A7III --HDMI--> ATEM Mini Pro ISO --USB webcam--> PC / OBS
Rode NTG --XLR--> mixer (48V + limiter) --line--> ATEM 3.5mm (embedded audio)
Stream Deck --> Companion --HTTP--> this controller --obs-websocket--> OBS
Booth monitor <-- OBS Fullscreen Projector (guest scene)
```

## Setup (on the booth PC)

1. Install [Node.js 18+](https://nodejs.org).
2. In this folder: `npm install`
3. `copy config.example.json config.json` and edit `config.json`:
   - `obs.password` — from OBS → Tools → WebSocket Server Settings.
   - `notify.url` — a webhook for phone alerts (e.g. an
     [ntfy.sh](https://ntfy.sh) topic URL). Leave blank to log only.
   - Confirm the `scenes` / `sources` names match what you build in OBS.
4. Build the OBS scenes and Companion buttons — see **RUNBOOK.md**.
5. Run it: `npm start`

## What it does

- **Self-healing for unattended use:** auto-stops a runaway recording, and a
  walk-away in the review screen keeps the take and resets for the next guest.
- **Keeps bloopers:** "start over" never deletes — *approved* takes go to the
  `approved/` subfolder and everything else (start-over / walk-away takes) goes
  to `bloopers/`. Nothing is ever thrown away.
- **Playback of the just-recorded take:** it reads the file path OBS returns on
  stop and loads it into the review Media Source automatically.
- **Watchdog:** phone alert if the recording stalls or the camera goes black.

## HTTP endpoints (what Companion calls)

| Method   | Path         | Valid in state        |
| -------- | ------------ | --------------------- |
| GET/POST | `/start`     | READY                 |
| GET/POST | `/stop`      | RECORDING             |
| GET/POST | `/startover` | COUNTDOWN, RECORDING, REVIEW |
| GET/POST | `/approve`   | REVIEW                |
| GET/POST | `/reset`     | any (operator escape) |
| GET      | `/state`     | — (returns JSON)      |

Commands invalid for the current state are ignored, so a stray key press can't
corrupt the flow.
