# Confessional Booth — Build & Run-Day Runbook

Everything needed to build the rig once and run it unattended on the day.

---

## 1. Signal chain

```
Sony A73  --micro-HDMI-->  ATEM Mini Pro ISO  --USB-C (webcam)-->  PC / OBS
Rode NTG  --XLR-->  mixer (48V phantom + limiter)  --line out-->  ATEM 3.5mm IN
[optional] boundary/PZM mic --> mixer ch.2 --> USB interface --> OBS (track 2)
Stream Deck --> Companion --> controller (HTTP :3939) --> OBS (websocket :4455)
Booth monitor (under the lens) <-- OBS Fullscreen Projector
```

- **The ATEM is a 1080p switcher** — the A73 feed is 1080p through it. Correct
  choice here; don't chase 4K.
- **NTG needs 48V phantom**, which the ATEM's 3.5mm inputs do NOT provide — the
  mixer supplies it. Set a **limiter** on the mixer; nobody is riding levels.
- Mount the shotgun **close + overhead, aimed at the center of the seat area** so
  two or three people across the couch stay roughly on-axis.
- Run a **backup wide mic on OBS track 2** — cheap insurance for multi-person
  takes, no lavs to lose.

---

## 2. Camera (Sony A73) — set once, then leave it

- **Clean HDMI:** Menu → Setup → HDMI Settings → **HDMI Info Display: OFF**.
- **Auto power off / temp:** **Power Save: OFF**, Auto Power OFF Temp: **High**.
- **Power from AC** via a dummy-battery coupler — not internal batteries, not USB.
  This runs for hours.
- **Micro-HDMI is the #1 failure point** — use a reinforced/locking cable and tape
  it down with strain relief. This is what the watchdog is guarding against.
- Continuous AF + Face/Eye AF on, manual exposure (so it doesn't hunt as people
  move), and add a **key light** so faces look good regardless of the venue.

---

## 3. ATEM Mini Pro ISO

- Feed A73 into an HDMI input; route the NTG line into the 3.5mm audio in and
  confirm it's **embedded in the program feed** (mic audio meters on the ATEM).
- **Run ISO recording to a fast USB-C SSD all night as the backup.** Yes, it's
  one continuous file — that's the point. If the PC dies, the whole reception is
  still captured (with a Resolve project). exFAT-formatted, fast SSD.
- ATEM shows up on the PC as a webcam → that's the OBS **Camera** source.

---

## 4. OBS

**Recording settings** (Settings → Output → Recording, Advanced):

- **Format: mkv** (crash-safe; remux to mp4 later). Recording path = wherever you
  want the takes; approved ones get moved to an `approved/` subfolder there.
- **Audio: Multitrack** — Track 1 = ATEM (shotgun), Track 2 = backup mic.
- Enable **Tools → WebSocket Server** (default port 4455) and set a password →
  put it in `config.json`.

**Scenes** (names must match `config.json`). Add the **Camera** capture device to
each live scene as the *same* source:

| Scene       | Contents                                                              |
| ----------- | -------------------------------------------------------------------- |
| `READY`     | Camera + text: "Get settled in frame, then press **START**"          |
| `ATTRACT`   | Camera (or a graphic) + "Leave a message for the couple 💍 — press START" |
| `COUNTDOWN` | Camera + big **`txt_countdown`** number + **`txt_prompt`** question  |
| `RECORDING` | Camera + big red ● REC + "When you're done, pause, then press **STOP**" + `txt_prompt` |
| `REVIEW`    | Media Source **`mediaReview`** + "Like it? **APPROVE** or **START OVER**" |
| `THANKS`    | "Thank you! 💕"                                                       |

Text sources = **`txt_countdown`** and **`txt_prompt`** (the controller writes to
these). Media source on REVIEW = **`mediaReview`** (leave it empty; the controller
sets its file). Then **right-click the preview → Fullscreen Projector → the booth
monitor**.

---

## 5. Companion (Stream Deck)

1. Companion → **Settings → enable the HTTP API** (note the port, default 8000 →
   `config.json` `companion.baseUrl`).
2. **Variables → Custom Variables → create three:** `booth_state`,
   `booth_status`, `booth_countdown`. The controller pushes live values into them.
3. Buttons — each **press action = HTTP Request** to the controller, and a
   **feedback** that shows the key only in the right state
   (Feedback: *Custom Variable → check value*, `booth_state` equals …):

   | Key         | Action (GET)                     | Show when `booth_state` = |
   | ----------- | -------------------------------- | ------------------------- |
   | START       | `http://127.0.0.1:3939/start`    | READY                     |
   | STOP        | `http://127.0.0.1:3939/stop`     | RECORDING                 |
   | START OVER  | `http://127.0.0.1:3939/startover`| COUNTDOWN, RECORDING, REVIEW |
   | APPROVE     | `http://127.0.0.1:3939/approve`  | REVIEW                    |
   | RESET (hide)| `http://127.0.0.1:3939/reset`    | (operator only)           |

   Dim/hide keys that aren't valid so a guest only ever sees the right buttons.
   Optionally show `$(internal:custom_booth_status)` as a key title for feedback.

---

## 6. Unattended hardening (the PC)

- **Disable Windows Update** for the day (a forced reboot ends the night),
  plus sleep, screensaver, and notifications.
- Auto-launch OBS + `npm start` on boot; put the controller in a loop/Task
  Scheduler so it restarts if it exits.
- **Lock the keyboard and mouse away** — only the Stream Deck is reachable.
- Put the PC (and ideally the camera light) on a **UPS**.
- Set `notify.url` so you get a phone ping if the feed dies.

---

## 7. Pre-event soak test (do this before the day)

1. Full dry run: START → countdown → record → STOP → review → APPROVE → confirm
   the file landed in `approved/`.
2. START OVER at each stage; confirm bloopers are **kept** (in the recording
   folder) and never shown to the next "guest".
3. Walk away in REVIEW; confirm it auto-resets and keeps the take.
4. Let a recording run past `maxRecordSeconds`; confirm auto-stop.
5. **Unplug the camera HDMI** mid-idle; confirm you get a black-feed phone alert.
6. **Run it 2+ hours** for camera heat, storage headroom, and stability. Check
   free disk = (takes × avg length × ~2 for bloopers) at your bitrate.

---

## 8. Teardown

- Everything not in `approved/` is bloopers — keep them, don't show them.
- Grab the ATEM SSD's continuous backup file too.
- Remux the mkv takes to mp4 for the editor.
