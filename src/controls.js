// The key map: one table for Input, the hand controls and (later) the Controls dialog.
// Defaults are the original's (Lib/Sys/RegInit.cpp SetKeyMappingToDefault), with WASD
// kept for walking and a few browser-safe substitutes noted in `note`.
// `codes` are KeyboardEvent.code values, or 'Mouse0' (left) / 'Mouse2' (right) / 'Wheel'.
// `modern`: the label in the modern hand style, where it differs.
export const KEYMAP = [
  { action: 'forward',  label: 'Walk forward',        codes: ['KeyW', 'ArrowUp'],       original: 'W' },
  { action: 'back',     label: 'Walk backward',       codes: ['KeyS', 'ArrowDown', 'KeyX'], original: 'X', note: 'S walks back here (it walked forward slowly in the original)' },
  { action: 'left',     label: 'Sidestep left',       codes: ['KeyA'],                  original: 'A' },
  { action: 'right',    label: 'Sidestep right',      codes: ['KeyD'],                  original: 'D' },
  { action: 'turnLeft', label: 'Turn left',           codes: ['ArrowLeft'],             original: '' },
  { action: 'turnRight',label: 'Turn right',          codes: ['ArrowRight'],            original: '' },
  { action: 'run',      label: 'Run',                 codes: ['ShiftLeft', 'ShiftRight'], original: 'W (run forward)', note: 'Shift runs while the hand is down (with the hand up it turns the wrist)' },
  { action: 'jump',     label: 'Jump',                codes: ['KeyQ'],                  original: 'Q' },
  { action: 'crouch',   label: 'Crouch',              codes: ['KeyZ'],                  original: 'Z' },
  { action: 'hand',     label: 'Move hand (hold)',    codes: ['Mouse0'],                original: 'Left mouse',
    modern: 'Fire (holding a gun) / pick up / use' },   // the modern hand style (modernhand.js)
  { action: 'grab',     label: 'Grab / drop',         codes: ['Mouse2'],                original: 'Right mouse', note: 'the browser menu on right click is suppressed' },
  { action: 'use',      label: 'Use / fire',          codes: ['Space'],                 original: 'Space' },
  { action: 'throw',    label: 'Throw',               codes: ['KeyF'],                  original: 'F' },
  { action: 'stow',     label: 'Stow / retrieve',     codes: ['KeyE'],                  original: 'E' },
  { action: 'wrist',    label: 'Rotate wrist (hold)', codes: ['ShiftLeft', 'ShiftRight'], original: 'Shift' },
  { action: 'arm',      label: 'Rotate arm (hold)',   codes: ['AltLeft', 'AltRight'],   original: 'Ctrl', note: 'Alt instead of Ctrl: Ctrl+W, pressed while walking, would close the browser tab' },
  { action: 'reach',    label: 'Reach in / out',      codes: ['Wheel'],                 original: '', note: 'new: the original set reach automatically' },
  { action: 'drop',     label: 'Drop gun',            codes: ['KeyG'],                  original: '' },
  { action: 'replayVO', label: 'Replay voice-over',   codes: ['KeyR'],                  original: 'R' },
];

const byAction = Object.fromEntries(KEYMAP.map((k) => [k.action, k]));
export const codesFor = (action) => byAction[action]?.codes || [];
// Whether any of an action's keys is in `set` (a Set of codes held or pressed).
export const has = (set, action) => codesFor(action).some((c) => set.has(c));
