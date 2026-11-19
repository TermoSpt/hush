// Keyboard shortcuts: one list of actions, user-changeable keys, and a screen to view and edit them.
'use strict';
/* global S, $, esc, toast, persist, openSheet, closeSheet, toggleTune, toggleMonitor, wipeSession, shareAction, activeChat, reviewMessage */

const KEY_ACTIONS = [
  { id: 'newChat', label: 'New chat', def: 'Ctrl+N', run: () => $('#new-chat').click() },
  { id: 'focus', label: 'Jump to the message box', def: 'Ctrl+K', run: () => $('#input').focus() },
  { id: 'attach', label: 'Attach files', def: 'Ctrl+O', run: () => $('#file-input').click() },
  { id: 'tune', label: 'Open or close Tune', def: 'Ctrl+,', run: () => toggleTune() },
  { id: 'monitor', label: 'Open or close the Monitor', def: 'Ctrl+M', run: () => toggleMonitor() },
  { id: 'models', label: 'Open Models', def: 'Ctrl+Shift+M', run: () => openSheet('models') },
  { id: 'review', label: 'Review the last answer', def: 'Alt+R', run: () => {
    const chat = activeChat();
    if (!chat) return;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (m.role === 'assistant' && m.content && !m.pending && !m.synthetic) { reviewMessage(chat, i); return; }
    }
  } },
  { id: 'copyChat', label: 'Copy the whole chat', def: 'Ctrl+Shift+E', run: () => shareAction('copy') },
  { id: 'wipe', label: 'Wipe session / lock vault', def: 'Ctrl+Shift+L', run: () => wipeSession() },
  { id: 'keys', label: 'Show keyboard shortcuts', def: 'Ctrl+/', run: () => openSheet('keys') },
];
const FIXED_KEYS = [
  ['Enter', 'Send the message'],
  ['Shift+Enter', 'New line in the message'],
  ['Esc', 'Stop the answer, or close the open panel'],
  ['Ctrl+V', 'Paste text, or a screenshot as an image'],
];
// Keys the window or Windows itself uses; don't let people bind these.
const RESERVED = ['Ctrl+W', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+P', 'Ctrl+F', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Alt+F4', 'F5', 'Ctrl+Shift+I'];

let recordingId = null;

function comboFromEvent(e) {
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(k)) return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let name = k.length === 1 ? k.toUpperCase() : k;
  // With Shift held, symbol keys report the shifted symbol; use the physical key instead.
  if (e.code && /^(Digit|Key)/.test(e.code)) name = e.code.replace(/^(Digit|Key)/, '');
  if (e.code === 'Slash') name = '/';
  if (e.code === 'Comma') name = ',';
  if (e.code === 'Period') name = '.';
  if (name === ' ') name = 'Space';
  parts.push(name);
  return parts.join('+');
}

const keyFor = (id) => {
  const a = KEY_ACTIONS.find((x) => x.id === id);
  return (S.prefs.keys && S.prefs.keys[id]) || (a ? a.def : '');
};
const kbd = (combo) => combo ? combo.split('+').map((p) => `<kbd>${esc(p)}</kbd>`).join('') : '<span class="def">none</span>';

// Returns true if the event was handled.
function handleShortcut(e) {
  if (recordingId) return recordKey(e);
  const combo = comboFromEvent(e);
  if (!combo) return false;
  const needsMod = /^(Ctrl|Alt)\+/.test(combo) || /^F\d+$/.test(combo);
  if (!needsMod) return false;
  const action = KEY_ACTIONS.find((a) => keyFor(a.id) === combo);
  if (!action) return false;
  e.preventDefault();
  action.run();
  return true;
}

function recordKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { recordingId = null; renderKeysSheet(); return true; }
  const combo = comboFromEvent(e);
  if (!combo) return true;
  if (!/^(Ctrl|Alt)\+/.test(combo) && !/^F\d+$/.test(combo)) { toast('Use Ctrl or Alt with a key (or an F key), so it never fires while you type.'); return true; }
  if (RESERVED.includes(combo)) { toast(`${combo} is used by the window or Windows itself. Pick another.`, 'bad'); return true; }
  const clash = KEY_ACTIONS.find((a) => a.id !== recordingId && keyFor(a.id) === combo);
  if (clash) { toast(`${combo} is already used for "${clash.label}".`, 'bad'); return true; }
  S.prefs.keys = { ...(S.prefs.keys || {}), [recordingId]: combo };
  recordingId = null;
  persist();
  renderKeysSheet();
  updateKeyHints();
  return true;
}

function renderKeysSheet() {
  if ($('#sheet').hidden || $('#sheet').dataset.kind !== 'keys') return;
  let html = `<h2>Keyboard shortcuts</h2><p class="lead">Click <b>Change</b>, then press the new keys. Shortcuts need Ctrl or Alt (or an F key) so they never fire while you type.${S.mode === 'vault' ? ' Your changes are saved in the vault.' : ' In an ephemeral session, changes last until you close Hush.'}</p>`;
  html += '<div class="keys-list">';
  for (const a of KEY_ACTIONS) {
    const rec = recordingId === a.id;
    const custom = S.prefs.keys && S.prefs.keys[a.id];
    html += `<div class="key-row${rec ? ' rec' : ''}"><span>${esc(a.label)}</span><span class="key-cur">${rec ? '<span class="live-status"><span class="live-dot"></span>Press the new keys… (Esc to cancel)</span>' : kbd(keyFor(a.id))}</span>
      <span class="key-acts">${rec ? '' : `<button class="btn small" data-key-change="${a.id}" type="button">Change</button>${custom ? `<button class="linkish" data-key-reset="${a.id}" type="button">reset</button>` : ''}`}</span></div>`;
  }
  html += '</div><h3>Always the same</h3><div class="keys-list">';
  for (const [k, l] of FIXED_KEYS) html += `<div class="key-row"><span>${esc(l)}</span><span class="key-cur">${kbd(k)}</span><span></span></div>`;
  html += '</div>';
  if (S.prefs.keys && Object.keys(S.prefs.keys).length) html += '<p style="margin-top:14px"><button class="btn small ghost" id="keys-reset-all" type="button">Reset all to defaults</button></p>';
  $('#sheet-body').innerHTML = html;
}

function updateKeyHints() {
  const k = $('#new-chat kbd');
  if (k) k.textContent = keyFor('newChat').replace(/\+/g, ' ');
  $('#wipe-btn').title = keyFor('wipe');
  $('#tune-toggle').title = `Tune this chat (${keyFor('tune')})`;
  $('#monitor-toggle').title = `Live view of your graphics card and model speed (${keyFor('monitor')})`;
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
  $('#sheet-body').addEventListener('click', (e) => {
    if ($('#sheet').dataset.kind !== 'keys') return;
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.keyChange) { recordingId = b.dataset.keyChange; renderKeysSheet(); }
    else if (b.dataset.keyReset) { delete S.prefs.keys[b.dataset.keyReset]; persist(); renderKeysSheet(); updateKeyHints(); }
    else if (b.id === 'keys-reset-all') { S.prefs.keys = {}; persist(); renderKeysSheet(); updateKeyHints(); }
  });
});
