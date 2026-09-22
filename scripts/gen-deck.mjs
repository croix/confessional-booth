import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const DBPATH = 'C:/Users/DFWStreaming/AppData/Roaming/companion/v5.0/db.sqlite';
const HTTP_CONN = 'ljbu842ZKJka4gS2-YoE_'; // generic-http connection (base URL http://127.0.0.1:3939/)
const CREST_B64 = 'data:image/png;base64,' + readFileSync('C:/Users/DFWStreaming/Projects/confessional-booth/public/crest-key.png').toString('base64');

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const nid = (n = 21) => Array.from({ length: n }, () => ALPHA[(Math.random() * ALPHA.length) | 0]).join('');
const p = (value, isExpression = false) => ({ value, isExpression });

// colours (RGB decimal)
const GOLD = 0xc9a961, DARKBG = 0x1b1813, NEARBLACK = 0x12100e, DIMTX = 0x4a463d;
const WHITE = 0xffffff, DIMEXP = 0x333026, RESETBG = 0x3c1414, RESETTX = 0xd98c8c, OUTLINE = 0xff000000;

const canvas = () => ({ type: 'canvas', id: 'canvas', name: 'Canvas', decoration: p('none'), showStatusIcons: p('none'), usage: 'auto' });
function box(color) {
  return { id: nid(), name: 'Box', usage: 'auto', type: 'box',
    enabled: p(true), opacity: p(100), x: p(0), y: p(0), width: p(100), height: p(100), rotation: p(0),
    color: typeof color === 'string' ? p(color, true) : p(color),
    borderWidth: p(0), borderColor: p(0), borderPosition: p('inside') };
}
function text(t, color, { size = 18, shrink = true, valign = 'center', y = 0, height = 100, opacity } = {}) {
  return { id: nid(), name: 'Text', usage: 'auto', type: 'text',
    enabled: p(true),
    opacity: opacity === undefined ? p(100) : (typeof opacity === 'string' ? p(opacity, true) : p(opacity)),
    x: p(0), y: p(y), width: p(100), height: p(height), rotation: p(0),
    text: typeof t === 'object' ? t : p(t),
    color: typeof color === 'string' ? p(color, true) : p(color),
    halign: p('center'), valign: p(valign),
    fontsize: p(size), fontsizeAllowShrink: p(shrink), font: p('companion-sans'), outlineColor: p(OUTLINE) };
}
function button(layers, downActions = []) {
  return {
    type: 'button-layered',
    style: { layers: [canvas(), ...layers] },
    options: { stepProgression: 'auto', stepExpression: '', rotaryActions: false, canModifyStyleInApis: false, notes: '' },
    feedbacks: [],
    steps: { 0: { action_sets: { down: downActions, up: [] }, options: { runWhileHeld: [] } } },
    localVariables: [],
  };
}
const getAction = (urlPath) => ({
  id: nid(), definitionId: 'get', connectionId: HTTP_CONN,
  options: { url: p(urlPath), header: p(''), jsonResultDataVariable: { isExpression: false }, result_stringify: p(true), statusCodeVariable: { isExpression: false } },
  upgradeIndex: 2, type: 'action',
});

// active expressions per column
const A = {
  start: '$(custom:booth_state) == "READY"',
  stop: '$(custom:booth_state) == "RECORDING"',
  keep: '$(custom:booth_state) == "REVIEW"',
  over: '$(custom:booth_state) == "COUNTDOWN" || $(custom:booth_state) == "RECORDING" || $(custom:booth_state) == "REVIEW"',
};
const bgExpr = (a) => `(${a}) ? ${GOLD} : ${DARKBG}`;
const txExpr = (a) => `(${a}) ? ${NEARBLACK} : ${DIMTX}`;
const expExpr = (a) => `(${a}) ? ${WHITE} : ${DIMEXP}`;
const flashOpacity = (a) => `(${a}) ? ((($(internal:time_s) % 2) == 0) ? 100 : 10) : 0`;

// ACTION button (row 1)
const actionBtn = (label, urlPath, a, size = 26) =>
  button([box(bgExpr(a)), text(label, txExpr(a), { size })], [getAction(urlPath)]);
// INDICATOR (row 0): flashing down-arrow when active
const indicatorBtn = (a) =>
  button([box(0x000000), text('\u25BC', GOLD, { size: 58, opacity: flashOpacity(a) })]);
// EXPLANATION (row 2)
const explainBtn = (label, a) =>
  button([box(0x000000), text(label, expExpr(a), { size: 26 })]);
// RESET (operator)
const resetBtn = () => button([box(RESETBG), text('RESET', RESETTX, { size: 27 })], [getAction('reset')]);
// CREST image layer
function imageLayer(b64) {
  return { id: nid(), name: 'Image', usage: 'auto', type: 'image',
    enabled: p(true), opacity: p(100), x: p(0), y: p(0), width: p(100), height: p(100), rotation: p(0),
    base64Image: p(b64), halign: p('center'), valign: p('center') };
}
const crestBtn = () => button([box(0x000000), imageLayer(CREST_B64)]);

// Build the 3x5 grid
const grid = {
  0: { 0: indicatorBtn(A.start), 1: indicatorBtn(A.stop), 2: indicatorBtn(A.keep), 3: indicatorBtn(A.over), 4: crestBtn() },
  1: { 0: actionBtn('START', 'start', A.start, 27), 1: actionBtn('STOP', 'stop', A.stop, 27), 2: actionBtn('KEEP\nIT', 'approve', A.keep, 46), 3: actionBtn('START\nOVER', 'startover', A.over, 46), 4: resetBtn() },
  2: { 0: explainBtn('Begin your\nmessage', A.start), 1: explainBtn('Finish\nrecording', A.stop), 2: explainBtn('Save this\ntake', A.keep), 3: explainBtn('Record\nagain', A.over), 4: crestBtn() },
};

// ---- write to SQLite ----
const db = new DatabaseSync(DBPATH);
db.exec('PRAGMA busy_timeout = 4000;');

// remove old default controls referenced by the page
const oldPage = JSON.parse(db.prepare('SELECT value FROM controls WHERE id LIKE ?').all('bank:%').length ? '{}' : '{}');
for (const id of ['bank:NL8-JLCnv8XUx58-I7fEH', 'bank:j114OSZ_ODLRxMtogKfUX', 'bank:tBAq0P9Mtb8QSz6FsQpek']) {
  try { db.prepare('DELETE FROM controls WHERE id=?').run(id); } catch {}
}

const controlsMap = {};
const ins = db.prepare('INSERT OR REPLACE INTO controls (id, value) VALUES (?, ?)');
for (const r of [0, 1, 2]) {
  controlsMap[r] = {};
  for (const c of [0, 1, 2, 3, 4]) {
    const bankId = 'bank:' + nid();
    ins.run(bankId, JSON.stringify(grid[r][c]));
    controlsMap[r][c] = bankId;
  }
}

// update page 1 mapping
const pageRow = db.prepare('SELECT value FROM pages WHERE id=1').get();
const page = JSON.parse(pageRow.value);
page.name = 'Booth';
page.controls = controlsMap;
db.prepare('UPDATE pages SET value=? WHERE id=1').run(JSON.stringify(page));

db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.close();
console.log('deck config written: 15 buttons, page mapped.');
console.log(JSON.stringify(controlsMap, null, 0));
