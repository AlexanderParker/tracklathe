// Songs kept in the browser.
//
// Downloading a file is export, not saving: it leaves the tab, it asks the
// operating system where to put it, and on a phone it disappears into a
// Downloads folder you then have to find again. Saving should mean "it is
// still here when I come back", which is what this does.
//
// localStorage rather than IndexedDB because a song is a few kilobytes of
// JSON and the whole library will not approach the quota. Every access is
// wrapped: localStorage throws outright in a private window in some
// browsers, and a synth that will not start because it could not read a
// preference is worse than one that forgets.

const PREFIX = "tracklathe.song.";
const AUTOSAVE = "tracklathe.autosave";

function available() {
  try {
    const probe = "tracklathe.probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch (e) {
    return false;
  }
}

export const canStore = available();

// Every saved song, newest first.
export function listSongs() {
  if (!canStore) return [];
  const out = [];
  for (let i = 0; i < localStorage.length; ++i) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    let savedAt = 0;
    try {
      savedAt = JSON.parse(raw).savedAt ?? 0;
    } catch (e) {
      // A corrupt entry still gets listed, so it can be deleted.
    }
    out.push({ name: key.slice(PREFIX.length), bytes: raw.length, savedAt });
  }
  out.sort((a, b) => b.savedAt - a.savedAt || a.name.localeCompare(b.name));
  return out;
}

export function saveSong(name, songJson) {
  if (!canStore) return { ok: false, error: "This browser will not let the page store anything" };
  const key = PREFIX + name;
  const payload = JSON.stringify({ savedAt: Date.now(), song: songJson });
  try {
    localStorage.setItem(key, payload);
    return { ok: true };
  } catch (e) {
    // Quota is the one that actually happens, and the message browsers give
    // for it is not something to show a musician.
    return {
      ok: false,
      error: e && e.name === "QuotaExceededError"
        ? "No room left in browser storage -- delete a song, or export this one to a file"
        : "Could not save to browser storage",
    };
  }
}

export function loadSong(name) {
  if (!canStore) return null;
  const raw = localStorage.getItem(PREFIX + name);
  if (!raw) return null;
  try {
    const wrapper = JSON.parse(raw);
    return wrapper && wrapper.song ? wrapper.song : wrapper;
  } catch (e) {
    return null;
  }
}

export function deleteSong(name) {
  if (!canStore) return;
  try { localStorage.removeItem(PREFIX + name); } catch (e) { /* nothing to do */ }
}

export function songExists(name) {
  if (!canStore) return false;
  return localStorage.getItem(PREFIX + name) !== null;
}

// ---------------------------------------------------------------- autosave

// A separate slot from the named saves, so work in progress is never
// confused with something deliberately kept, and closing the tab by accident
// does not cost the session.
export function autosave(songJson) {
  if (!canStore) return;
  try {
    localStorage.setItem(AUTOSAVE, JSON.stringify({ savedAt: Date.now(), song: songJson }));
  } catch (e) {
    // Out of room: the named saves matter more than this one.
  }
}

export function readAutosave() {
  if (!canStore) return null;
  const raw = localStorage.getItem(AUTOSAVE);
  if (!raw) return null;
  try {
    const w = JSON.parse(raw);
    return w && w.song ? { song: w.song, savedAt: w.savedAt ?? 0 } : null;
  } catch (e) {
    return null;
  }
}

export function clearAutosave() {
  if (!canStore) return;
  try { localStorage.removeItem(AUTOSAVE); } catch (e) { /* nothing to do */ }
}

export function describeAge(ts) {
  if (!ts) return "";
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
