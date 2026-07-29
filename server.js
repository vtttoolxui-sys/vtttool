'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const VERSION = require('./package.json').version;

const PORT = process.env.PORT || 35600;
const DB_PATH = path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

// Extraction hard-depends on ffmpeg being on PATH — without it every extraction fails with a
// cryptic ENOENT deep in a child_process call. Checked once at startup (not per-request) so
// the failure is loud and immediate instead of surfacing later as a confusing per-item error.
// Reports the underlying error code too (not just true/false) — e.g. ENOENT usually means
// ffmpeg isn't on PATH at all (or, on an XUI box, that the panel's symlink is dangling because
// its target got moved/removed), while EACCES points at a permissions problem on the binary
// itself, which "is ffmpeg installed?" alone can't distinguish.
let ffmpegAvailable = null;
let ffmpegCheckError = null;
function checkFfmpegAvailable() {
  return new Promise(resolve => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err) => {
      ffmpegCheckError = err ? (err.code || err.message) : null;
      resolve(!err);
    });
  });
}

// ── Local SQLite ──────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS vod_subs_status (
    stream_id  INTEGER PRIMARY KEY,
    title      TEXT,
    container  TEXT,
    status     TEXT NOT NULL DEFAULT 'unknown',
    languages  TEXT,
    error      TEXT,
    duration_sec INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS series_subs_status (
    id            INTEGER PRIMARY KEY,
    series_id     INTEGER,
    series_name   TEXT,
    season_num    INTEGER,
    episode_num   INTEGER,
    episode_title TEXT,
    container     TEXT,
    status        TEXT NOT NULL DEFAULT 'unknown',
    languages     TEXT,
    error         TEXT,
    duration_sec  INTEGER,
    added         INTEGER,
    updated_at    INTEGER
  );
  CREATE TABLE IF NOT EXISTS xui_movies_container_cache (
    id INTEGER PRIMARY KEY CHECK(id=1),
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS xui_series_episodes_cache (
    id INTEGER PRIMARY KEY CHECK(id=1),
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// ── Settings helpers ──────────────────────────────────────────────────────────
const SETTING_DEFAULTS = {
  // Xtream login for extraction — the panel's regular stream login (same kind of
  // playback URL the TV app itself uses), NOT a direct XUI database connection.
  xtream_base:            '',
  xtream_user:            '',
  xtream_pass:            '',
  xui_sync_hours:         '2',    // how often the movie/episode list is reloaded from Xtream
  // 0 = unlimited. Otherwise each extraction is rate-limited (curl --limit-rate into
  // ffmpeg) so a large batch run doesn't saturate the server's own uplink.
  subs_max_bandwidth_mbit: '0',
  subs_auto_enabled:       '0',
  subs_batch_interval_hours: '6',
  // API key protecting /subs-* (entered in the webOS app, 6-10 characters).
  subs_api_key:           '',
  // Simple webif login (optional — empty username = no login required)
  webif_username:         '',
  webif_password_hash:    '',
  webif_password_salt:    '',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (row) return row.value;
  return SETTING_DEFAULTS[key] ?? '';
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, String(value));
}
function getSettingInt(key) { return parseInt(getSetting(key)) || parseInt(SETTING_DEFAULTS[key]) || 0; }

// ── Brute force beskyttelse (webif-login) ─────────────────────────────────────
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const BLOCK_MS = 15 * 60 * 1000;

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function isBlocked(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.blockedUntil && Date.now() < entry.blockedUntil) return true;
  if (entry.blockedUntil && Date.now() >= entry.blockedUntil) loginAttempts.delete(ip);
  return false;
}
function recordFailure(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, blockedUntil: null };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) entry.blockedUntil = Date.now() + BLOCK_MS;
  loginAttempts.set(ip, entry);
}
function clearFailures(ip) { loginAttempts.delete(ip); }

// ── Session management ────────────────────────────────────────────────────────
const sessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + SESSION_TTL_MS });
  return token;
}
function isValidSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expires) { sessions.delete(token); return false; }
  return true;
}
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}
function authMiddleware(req, res, next) {
  const webifUser = getSetting('webif_username');
  if (!webifUser) return next();
  const cookies = parseCookies(req);
  if (!isValidSession(cookies.vt_session)) return res.status(401).json({ error: 'Not authorized' });
  next();
}

// ── HTTP fetch helper (follows redirects) ──────────────────────────────────────
function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'vtttool/1.0' },
    }, res => {
      if (res.statusCode >= 301 && res.statusCode <= 303 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        res.resume(); return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── VOD subtitle extraction ──────────────────────────────────────────────────
// The client side (webOS app) can't pull subtitles out of MKV files without
// streaming the whole file through a second time in parallel with playback
// itself — double bandwidth, double load on the panel server. So ffmpeg runs
// server-side instead (once per movie/episode), saving the result as small
// .vtt files the app just fetches directly afterwards.
const SUBS_DIR = path.join(__dirname, 'data', 'subs');
fs.mkdirSync(SUBS_DIR, { recursive: true });

// A service restart mid-extraction leaves the spawned ffmpeg/curl child process(es) running,
// reparented to init — the in-memory queue that used to track them is gone (fresh process,
// empty state), so nothing will ever kill or report on them again; they just sit there until
// they eventually finish or the box runs out of resources. Recovered by killing anything whose
// command line contains our own SUBS_DIR (ffmpeg's output path — a fingerprint that can never
// match this panel's own separate live-transcoding ffmpeg processes) or the configured
// xtream_base host on a movie/series URL (the curl leg of a bandwidth-limited extraction).
// pkill exits 1 when nothing matches, which is the normal/expected case, not a failure.
function killOrphanedExtractionProcesses() {
  return new Promise(resolve => {
    execFile('pkill', ['-9', '-f', SUBS_DIR], () => {
      const base = getSetting('xtream_base').replace(/\/+$/, '');
      if (!base) return resolve();
      execFile('pkill', ['-9', '-f', `${base}/(movie|series)/`], () => resolve());
    });
  });
}

function buildXtreamMovieUrl(streamId, container) {
  const base = getSetting('xtream_base').replace(/\/+$/, '');
  const user = getSetting('xtream_user');
  const pass = getSetting('xtream_pass');
  if (!base || !user || !pass) throw new Error('Xtream login not configured (Settings)');
  return `${base}/movie/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${streamId}.${container || 'mkv'}`;
}
function buildXtreamEpisodeUrl(episodeId, container) {
  const base = getSetting('xtream_base').replace(/\/+$/, '');
  const user = getSetting('xtream_user');
  const pass = getSetting('xtream_pass');
  if (!base || !user || !pass) throw new Error('Xtream login not configured (Settings)');
  return `${base}/series/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${episodeId}.${container || 'mkv'}`;
}

// Filmliste inkl. target_container, hentet via Xtream API (get_vod_streams) — samme kilde
// som TV-appen selv bruger, ikke en direkte XUI-database-forbindelse.
async function getXuiMoviesWithContainer(forceRefresh = false) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = getSettingInt('xui_sync_hours') * 3600;
  const cached = db.prepare('SELECT data, updated_at FROM xui_movies_container_cache WHERE id=1').get();
  if (!forceRefresh && cached && (now - cached.updated_at) < ttl) return JSON.parse(cached.data);

  const base = getSetting('xtream_base').replace(/\/+$/, '');
  const user = getSetting('xtream_user');
  const pass = getSetting('xtream_pass');
  if (!base || !user || !pass) throw new Error('Xtream login not configured (Settings)');

  const url = `${base}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_vod_streams`;
  const raw = await fetchUrl(url);
  let rows;
  try { rows = JSON.parse(raw); } catch (e) { throw new Error('Could not parse response from Xtream API (invalid JSON)'); }
  if (!Array.isArray(rows)) throw new Error('Unexpected response from Xtream API — check login under Settings');

  const movies = rows.map(r => ({
    id: r.stream_id,
    title: r.name || '',
    container: r.container_extension || 'mkv',
    added: r.added ? parseInt(r.added, 10) : null,
  }));
  const data = JSON.stringify(movies);
  db.prepare('INSERT OR REPLACE INTO xui_movies_container_cache(id,data,updated_at) VALUES(1,?,?)').run(data, now);
  return movies;
}

// Episode list analogous to getXuiMoviesWithContainer() above, but for series episodes.
// Xtream has no single "all episodes" endpoint: get_series gives the series list, but each
// episode has to be looked up individually via get_series_info&series_id=X — fetched in small
// concurrent chunks so as not to hit the panel with hundreds of sequential calls.
async function getXuiEpisodesWithContainer(forceRefresh = false) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = getSettingInt('xui_sync_hours') * 3600;
  const cached = db.prepare('SELECT data, updated_at FROM xui_series_episodes_cache WHERE id=1').get();
  if (!forceRefresh && cached && (now - cached.updated_at) < ttl) return JSON.parse(cached.data);

  const base = getSetting('xtream_base').replace(/\/+$/, '');
  const user = getSetting('xtream_user');
  const pass = getSetting('xtream_pass');
  if (!base || !user || !pass) throw new Error('Xtream login not configured (Settings)');

  const seriesUrl = `${base}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_series`;
  const rawSeries = await fetchUrl(seriesUrl);
  let seriesRows;
  try { seriesRows = JSON.parse(rawSeries); } catch (e) { throw new Error('Could not parse response from Xtream API (invalid JSON, get_series)'); }
  if (!Array.isArray(seriesRows)) throw new Error('Unexpected response from Xtream API (get_series) — check login under Settings');

  const episodes = [];
  const CHUNK = 8;
  for (let i = 0; i < seriesRows.length; i += CHUNK) {
    const chunk = seriesRows.slice(i, i + CHUNK);
    await Promise.all(chunk.map(async s => {
      try {
        const infoUrl = `${base}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_series_info&series_id=${s.series_id}`;
        const rawInfo = await fetchUrl(infoUrl);
        let info;
        try { info = JSON.parse(rawInfo); } catch (e) { return; }
        const epsBySeason = (info && info.episodes) || {};
        for (const seasonKey of Object.keys(epsBySeason)) {
          for (const ep of (epsBySeason[seasonKey] || [])) {
            const addedRaw = ep.added || s.last_modified || null;
            const epNum = ep.episode_num != null ? parseInt(ep.episode_num, 10) : null;
            const seasonNum = ep.season != null ? parseInt(ep.season, 10) : parseInt(seasonKey, 10);
            episodes.push({
              id: parseInt(ep.id, 10),
              series_id: s.series_id,
              series_name: s.name || '',
              season_num: isNaN(seasonNum) ? null : seasonNum,
              episode_num: isNaN(epNum) ? null : epNum,
              episode_title: ep.title || '',
              container: ep.container_extension || 'mkv',
              added: addedRaw ? parseInt(addedRaw, 10) : null,
            });
          }
        }
      } catch (e) { /* ét seriepanel-opslag der fejler skal ikke stoppe hele opdateringen */ }
    }));
  }
  const data = JSON.stringify(episodes);
  db.prepare('INSERT OR REPLACE INTO xui_series_episodes_cache(id,data,updated_at) VALUES(1,?,?)').run(data, now);
  return episodes;
}

// This server may only have XUI's own ffmpeg binary (used for the panel's transcoding).
// Rather than risk overwriting/restarting it with a separate ffprobe install, plain
// `ffmpeg -i <url>` is used instead: it writes stream info to stderr with no output file
// needed — the exit code is always non-zero here, so errors are decided by whether stderr
// contains any "Stream #" lines at all, not by the exit code.
function ffprobeSubtitleStreams(url) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-i', url], { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = stderr || '';
      if (!/Stream #0:/.test(text)) {
        return reject(new Error(err ? err.message.split('\n')[0] : 'No streams found in the file — check URL/login'));
      }
      const subs = [...text.matchAll(/Stream #0:(\d+)(?:\(([a-zA-Z]+)\))?: Subtitle: (\S+)/g)]
        .map(m => ({ index: parseInt(m[1], 10), language: m[2] || 'und', codec_name: m[3].replace(/,$/, '') }));
      const durMatch = text.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      const durationSec = durMatch
        ? parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseInt(durMatch[3], 10) + parseInt(durMatch[4], 10) / 100
        : null;
      resolve({ subs, durationSec });
    });
  });
}

// Pulls all requested subtitle streams out in ONE combined ffmpeg run (one -map + output per
// stream), instead of one ffmpeg run per language — ffmpeg has to read through the whole file
// regardless of how many streams it pulls out, so one run per language would multiply the
// read cost (and time) by the number of languages for no reason.
function wireProgressStream(stdout, durationSec, onProgress) {
  if (!durationSec || !onProgress) return;
  let buf = '';
  stdout.on('data', chunk => {
    buf += chunk;
    const matches = buf.match(/out_time_ms=(\d+)/g);
    if (matches) {
      const outMs = parseInt(matches[matches.length - 1].split('=')[1], 10);
      onProgress(Math.min(100, Math.round((outMs / 1e6 / durationSec) * 100)));
    }
    buf = buf.slice(-2000);
  });
}

// maxBandwidthMbit: 0/undefined = unlimited (ffmpeg reads the URL directly). Otherwise the
// download is piped through `curl --limit-rate` into ffmpeg's stdin instead — so an unlimited
// batch extraction doesn't saturate the server's uplink (which may also run live IPTV transcoding).
function ffmpegExtractAllSubtitles(url, subs, outDir, durationSec, onProgress, maxBandwidthMbit, onProcess) {
  const outArgs = [];
  for (const s of subs) outArgs.push('-map', `0:${s.index}`, '-c:s', 'webvtt', path.join(outDir, `${s.lang}.vtt`));

  if (!maxBandwidthMbit) {
    const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-i', url, ...outArgs];
    return new Promise((resolve, reject) => {
      const child = execFile('ffmpeg', args, { timeout: 20 * 60 * 1000, maxBuffer: 1024 * 1024 }, (err) => { if (err) return reject(err); resolve(); });
      if (onProcess) onProcess({ kill() { try { child.kill('SIGKILL'); } catch (e) { /* already dead */ } } });
      wireProgressStream(child.stdout, durationSec, onProgress);
    });
  }

  const rateBytesPerSec = Math.floor((maxBandwidthMbit * 1000000) / 8);
  return new Promise((resolve, reject) => {
    // -L is required — stream URLs can 302-redirect to a different load-balancer host with a
    // signed token, and curl doesn't follow redirects by default (unlike ffmpeg's own HTTP
    // demuxer). Without it curl just "succeeds" while piping 0 bytes (the redirect response itself).
    const curl = spawn('curl', ['-sL', '--limit-rate', String(rateBytesPerSec), url]);
    const ffmpeg = spawn('ffmpeg', ['-y', '-v', 'error', '-progress', 'pipe:1', '-i', 'pipe:0', ...outArgs]);
    if (onProcess) onProcess({ kill() {
      try { curl.kill('SIGKILL'); } catch (e) { /* already dead */ }
      try { ffmpeg.kill('SIGKILL'); } catch (e) { /* already dead */ }
    } });
    curl.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdin.on('error', () => {});
    curl.on('error', reject);
    curl.stderr.on('data', () => {});
    wireProgressStream(ffmpeg.stdout, durationSec, onProgress);
    let ffmpegErr = '';
    ffmpeg.stderr.on('data', c => { ffmpegErr += c; });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exited ' + code + ': ' + ffmpegErr.slice(0, 300)));
    });
  });
}

// ffmpeg's WebVTT muxer omits the hour component on cue timestamps under an hour long
// (e.g. "00:07.004 --> 00:10.407" instead of "00:00:07.004 --> 00:00:10.407"). That's valid
// per the WebVTT spec, but several embedded/TV subtitle parsers (LG webOS included) are
// stricter than browsers and silently fail to decode any cues at all without the full
// HH:MM:SS.mmm form — which looks exactly like "the track exists but shows no text". Normalize
// every timestamp to always include hours right after extraction, once, rather than relying on
// every downstream player to handle the spec's optional short form.
function normalizeVttTimestamps(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const padTimestamp = ts => (ts.split(':').length === 2 ? '00:' + ts : ts);
  const fixed = content.replace(
    /(\d{1,2}(?::\d{2})?:\d{2}\.\d{3})(\s*-->\s*)(\d{1,2}(?::\d{2})?:\d{2}\.\d{3})/g,
    (match, start, arrow, end) => padTimestamp(start) + arrow + padTimestamp(end)
  );
  if (fixed !== content) fs.writeFileSync(filePath, fixed);
}

async function extractMovieSubs(streamId, title, container) {
  const url = buildXtreamMovieUrl(streamId, container);
  const outDir = path.join(SUBS_DIR, 'movies', String(streamId));
  const now = () => Math.floor(Date.now() / 1000);
  const startedAtMs = Date.now();
  db.prepare(`INSERT OR REPLACE INTO vod_subs_status(stream_id,title,container,status,updated_at) VALUES(?,?,?,?,?)`)
    .run(streamId, title, container, 'extracting', now());
  try {
    const { subs, durationSec } = await ffprobeSubtitleStreams(url);
    const textSubs = subs.filter(s => ['subrip', 'ass', 'ssa', 'mov_text'].includes(s.codec_name));
    if (!textSubs.length) {
      db.prepare(`UPDATE vod_subs_status SET status='no_subs', languages='[]', error=NULL, updated_at=? WHERE stream_id=?`).run(now(), streamId);
      return { status: 'no_subs' };
    }
    fs.mkdirSync(outDir, { recursive: true });
    const seen = new Set();
    const toExtract = [];
    for (const s of textSubs) {
      const lang = s.language || 'und';
      if (seen.has(lang)) continue;
      seen.add(lang);
      toExtract.push({ index: s.index, lang });
    }
    subsQueueState.currentProgressPct = 0;
    const maxBandwidthMbit = getSettingInt('subs_max_bandwidth_mbit');
    await ffmpegExtractAllSubtitles(url, toExtract, outDir, durationSec, pct => { subsQueueState.currentProgressPct = pct; }, maxBandwidthMbit,
      proc => { subsQueueState.currentProc = proc; });
    for (const s of toExtract) normalizeVttTimestamps(path.join(outDir, `${s.lang}.vtt`));
    const langs = toExtract.map(s => s.lang);
    const durationSecTaken = Math.round((Date.now() - startedAtMs) / 1000);
    db.prepare(`UPDATE vod_subs_status SET status='done', languages=?, error=NULL, duration_sec=?, updated_at=? WHERE stream_id=?`)
      .run(JSON.stringify(langs), durationSecTaken, now(), streamId);
    return { status: 'done', languages: langs, duration_sec: durationSecTaken };
  } catch (e) {
    const errMsg = subsQueueState.currentKilledManually ? 'Manually aborted' : String(e.message || e);
    db.prepare(`UPDATE vod_subs_status SET status='error', error=?, updated_at=? WHERE stream_id=?`).run(errMsg, now(), streamId);
    throw e;
  } finally {
    subsQueueState.currentProc = null;
  }
}

async function extractEpisodeSubs(episodeId, meta) {
  const { series_id, series_name, season_num, episode_num, episode_title, container, added } = meta;
  const url = buildXtreamEpisodeUrl(episodeId, container);
  const outDir = path.join(SUBS_DIR, 'series', String(episodeId));
  const now = () => Math.floor(Date.now() / 1000);
  const startedAtMs = Date.now();
  db.prepare(`INSERT OR REPLACE INTO series_subs_status(id,series_id,series_name,season_num,episode_num,episode_title,container,status,added,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(episodeId, series_id ?? null, series_name || '', season_num ?? null, episode_num ?? null, episode_title || '', container, 'extracting', added ?? null, now());
  try {
    const { subs, durationSec } = await ffprobeSubtitleStreams(url);
    const textSubs = subs.filter(s => ['subrip', 'ass', 'ssa', 'mov_text'].includes(s.codec_name));
    if (!textSubs.length) {
      db.prepare(`UPDATE series_subs_status SET status='no_subs', languages='[]', error=NULL, updated_at=? WHERE id=?`).run(now(), episodeId);
      return { status: 'no_subs' };
    }
    fs.mkdirSync(outDir, { recursive: true });
    const seen = new Set();
    const toExtract = [];
    for (const s of textSubs) {
      const lang = s.language || 'und';
      if (seen.has(lang)) continue;
      seen.add(lang);
      toExtract.push({ index: s.index, lang });
    }
    subsQueueState.currentProgressPct = 0;
    const maxBandwidthMbit = getSettingInt('subs_max_bandwidth_mbit');
    await ffmpegExtractAllSubtitles(url, toExtract, outDir, durationSec, pct => { subsQueueState.currentProgressPct = pct; }, maxBandwidthMbit,
      proc => { subsQueueState.currentProc = proc; });
    for (const s of toExtract) normalizeVttTimestamps(path.join(outDir, `${s.lang}.vtt`));
    const langs = toExtract.map(s => s.lang);
    const durationSecTaken = Math.round((Date.now() - startedAtMs) / 1000);
    db.prepare(`UPDATE series_subs_status SET status='done', languages=?, error=NULL, duration_sec=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(langs), durationSecTaken, now(), episodeId);
    return { status: 'done', languages: langs, duration_sec: durationSecTaken };
  } catch (e) {
    const errMsg = subsQueueState.currentKilledManually ? 'Manually aborted' : String(e.message || e);
    db.prepare(`UPDATE series_subs_status SET status='error', error=?, updated_at=? WHERE id=?`).run(errMsg, now(), episodeId);
    throw e;
  } finally {
    subsQueueState.currentProc = null;
  }
}

// ── Background queue for batch extraction ──────────────────────────────────────
// ONE shared queue for both movies and series episodes — never more than one ffmpeg/curl
// extraction running at a time. currentType follows currentId everywhere, since movie and
// episode ids can collide (two different Xtream id spaces).
const subsQueueState = { running: false, queue: [], done: 0, total: 0, errors: 0, current: null, currentId: null, currentType: null, currentProgressPct: 0, currentProc: null, currentKilledManually: false };

async function runSubsQueue() {
  if (subsQueueState.running) return;
  subsQueueState.running = true;
  try {
    while (subsQueueState.queue.length) {
      const item = subsQueueState.queue.shift();
      subsQueueState.current = item.title;
      subsQueueState.currentId = item.id;
      subsQueueState.currentType = item.type;
      subsQueueState.currentKilledManually = false;
      let result = null, err = null;
      try {
        result = item.type === 'episode'
          ? await extractEpisodeSubs(item.id, item)
          : await extractMovieSubs(item.id, item.title, item.container);
      }
      catch (e) { err = e; subsQueueState.errors++; }
      subsQueueState.done++;
      if (item.resolvers) {
        const response = err ? { ok: false, error: String(err.message || err) } : { ok: true, ...result };
        item.resolvers.forEach(fn => fn(response));
      }
    }
  } finally {
    subsQueueState.running = false;
    subsQueueState.current = null;
    subsQueueState.currentId = null;
    subsQueueState.currentType = null;
  }
}

function enqueueSubsExtraction(items) {
  const existingKeys = new Set(subsQueueState.queue.map(i => `${i.type}:${i.id}`));
  const fresh = items.filter(i => !existingKeys.has(`${i.type}:${i.id}`));
  subsQueueState.queue.push(...fresh);
  subsQueueState.total = subsQueueState.done + subsQueueState.queue.length + (subsQueueState.running ? 1 : 0);
  runSubsQueue();
  return fresh.length;
}

// Used by the manual "Extract" button — routes through the SAME queue as "extract all
// missing", so there's never more than one ffmpeg/curl extraction running at a time. Jumps
// the queue (unshift) since an explicit click shouldn't have to wait behind a large auto-batch.
function enqueueAndWait(item) {
  if (subsQueueState.currentId === item.id && subsQueueState.currentType === item.type) {
    return Promise.resolve({ ok: false, error: item.type === 'episode' ? 'This episode is already being extracted' : 'This movie is already being extracted' });
  }
  return new Promise((resolve) => {
    let target = subsQueueState.queue.find(i => i.id === item.id && i.type === item.type);
    if (target) {
      subsQueueState.queue = subsQueueState.queue.filter(i => i !== target);
    } else {
      target = { ...item, resolvers: [] };
      subsQueueState.total = subsQueueState.done + subsQueueState.queue.length + 1 + (subsQueueState.running ? 1 : 0);
    }
    if (!target.resolvers) target.resolvers = [];
    target.resolvers.push(resolve);
    subsQueueState.queue.unshift(target);
    runSubsQueue();
  });
}

function ensureSubsApiKey() { return getSetting('subs_api_key'); }

function episodeDisplayTitle(ep) {
  const s = ep.season_num != null ? String(ep.season_num).padStart(2, '0') : '??';
  const e = ep.episode_num != null ? String(ep.episode_num).padStart(2, '0') : '??';
  return `${ep.series_name || '?'} — S${s}E${e}${ep.episode_title ? ' — ' + ep.episode_title : ''}`;
}
function subsTypeOk(type) { return type === 'movie' || type === 'episode'; }

// ── Periodic auto-extraction of new movies/episodes ──────────────────────────────
let subsAutoTimer = null;
function scheduleJobs() {
  if (subsAutoTimer) clearInterval(subsAutoTimer);
  const subsAutoEnabled = getSetting('subs_auto_enabled') === '1';
  const subsHours = getSettingInt('subs_batch_interval_hours');
  if (subsAutoEnabled && subsHours > 0) {
    subsAutoTimer = setInterval(async () => {
      const configured = getSetting('xtream_base') && getSetting('xtream_user') && getSetting('xtream_pass');
      if (!configured) return;
      console.log(`[${new Date().toISOString()}] Auto-extracting subtitles for new movies/episodes...`);
      try {
        const movies = await getXuiMoviesWithContainer(true);
        const doneIds = new Set(db.prepare(`SELECT stream_id FROM vod_subs_status WHERE status IN ('done','no_subs')`).all().map(r => r.stream_id));
        const todoMovies = movies.filter(m => !doneIds.has(m.id)).map(m => ({ id: m.id, type: 'movie', title: m.title, container: m.container }));
        const episodes = await getXuiEpisodesWithContainer(true);
        const doneEpIds = new Set(db.prepare(`SELECT id FROM series_subs_status WHERE status IN ('done','no_subs')`).all().map(r => r.id));
        const todoEps = episodes.filter(ep => !doneEpIds.has(ep.id)).map(ep => ({
          id: ep.id, type: 'episode', title: episodeDisplayTitle(ep), container: ep.container,
          series_id: ep.series_id, series_name: ep.series_name, season_num: ep.season_num,
          episode_num: ep.episode_num, episode_title: ep.episode_title, added: ep.added,
        }));
        const queued = enqueueSubsExtraction([...todoMovies, ...todoEps]);
        console.log(`Auto-extract: ${queued} new items queued`);
      } catch (e) { console.error('Auto-extract error:', e.message); }
    }, subsHours * 3600 * 1000);
  }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false }));

// The .vtt files need to be fetchable by the webOS app (which has no webif login session),
// but shouldn't sit fully open — protected with an API key in the query string instead, since
// HTML5's <track src> can't send custom headers, only a plain GET URL.
function requireSubsApiKey(req, res, next) {
  const key = ensureSubsApiKey();
  if (!key || req.query.key !== key) return res.status(403).json({ error: 'Invalid or missing API key' });
  next();
}
// Subtitle storage is split into SUBS_DIR/movies/<id>/ and SUBS_DIR/series/<id>/ — movie and
// episode ids come from two different Xtream id spaces and can collide.
const SUBS_TYPE_DIR = { movie: 'movies', episode: 'series' };

// Simple health check the webOS app can use to confirm connection+key right away.
app.get('/subs-ping', requireSubsApiKey, (req, res) => res.json({ ok: true }));

// Public (API-key-protected) lookup the webOS app uses to ask "do you have subtitles
// for this movie/episode?" before it fetches any .vtt files.
app.get('/subs-info/:type/:id', requireSubsApiKey, (req, res) => {
  const type = req.params.type;
  if (type !== 'movie' && type !== 'episode') return res.status(404).json({ error: 'Invalid type' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.json({ status: 'unknown', languages: [] });
  const row = type === 'movie'
    ? db.prepare('SELECT status, languages FROM vod_subs_status WHERE stream_id=?').get(id)
    : db.prepare('SELECT status, languages FROM series_subs_status WHERE id=?').get(id);
  if (!row) return res.json({ status: 'unknown', languages: [] });
  res.json({ status: row.status, languages: row.languages ? JSON.parse(row.languages) : [] });
});

// Serves the .vtt file for a given type+id+language. :type/:id are validated explicitly, and
// the final path is confirmed to live under the correct SUBS_DIR/<movies|series> root, so a
// crafted :lang or :id can never produce path traversal.
app.get('/subs/:type/:id/:lang.vtt', requireSubsApiKey, (req, res) => {
  const type = req.params.type;
  const subDir = SUBS_TYPE_DIR[type];
  if (!subDir) return res.status(404).json({ error: 'Invalid type' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== req.params.id) return res.status(400).json({ error: 'Invalid id' });
  const lang = req.params.lang;
  if (!/^[a-zA-Z0-9_-]+$/.test(lang)) return res.status(400).json({ error: 'Invalid language' });
  const allowedRoot = path.resolve(path.join(SUBS_DIR, subDir));
  const resolved = path.resolve(path.join(allowedRoot, String(id), `${lang}.vtt`));
  if (!resolved.startsWith(allowedRoot + path.sep)) return res.status(400).json({ error: 'Invalid path' });
  res.sendFile(resolved, err => { if (err && !res.headersSent) res.status(404).json({ error: 'File not found' }); });
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/health', (req, res) => res.json({ status: 'alive', version: VERSION, ffmpeg: ffmpegAvailable, ffmpegError: ffmpegCheckError }));

// ── Auth endpoints (no authentication required) ─────────────────────────────
app.get('/api/auth-check', (req, res) => {
  const webifUser = getSetting('webif_username');
  if (!webifUser) return res.json({ ok: true, loginRequired: false });
  const cookies = parseCookies(req);
  if (!isValidSession(cookies.vt_session)) return res.status(401).json({ ok: false, loginRequired: true });
  res.json({ ok: true, loginRequired: true, username: webifUser });
});

app.post('/api/login', (req, res) => {
  const ip = getClientIp(req);
  if (isBlocked(ip)) return res.status(429).json({ ok: false, message: 'Too many failed attempts – try again in 15 minutes' });
  const { username, password } = req.body || {};
  const storedUser = getSetting('webif_username');
  const storedHash = getSetting('webif_password_hash');
  const storedSalt = getSetting('webif_password_salt');
  if (!storedUser) return res.status(401).json({ ok: false, message: 'No login configured' });
  if (!username || !password) {
    recordFailure(ip);
    return res.status(401).json({ ok: false, message: 'Invalid credentials' });
  }
  if (username !== storedUser || hashPassword(password, storedSalt) !== storedHash) {
    recordFailure(ip);
    const entry = loginAttempts.get(ip);
    const left = MAX_ATTEMPTS - (entry?.count || 0);
    const msg = left > 0 ? `Incorrect username or password (${left} attempts left)` : 'Too many failed attempts – try again in 15 minutes';
    return res.status(401).json({ ok: false, message: msg });
  }
  clearFailures(ip);
  const token = createSession();
  res.setHeader('Set-Cookie', `vt_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 3600}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.vt_session) sessions.delete(cookies.vt_session);
  res.setHeader('Set-Cookie', 'vt_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

// ── Auth protection for all other API endpoints ─────────────────────────────
app.use('/api', authMiddleware);

app.get('/api/settings', (req, res) => {
  res.json({
    xtream_base:            getSetting('xtream_base'),
    xtream_user:            getSetting('xtream_user'),
    xtream_pass:            getSetting('xtream_pass') ? '***set***' : '',
    xui_sync_hours:         getSetting('xui_sync_hours') || '2',
    subs_max_bandwidth_mbit: getSetting('subs_max_bandwidth_mbit') || '0',
    subs_auto_enabled:      getSetting('subs_auto_enabled') || '0',
    subs_batch_interval_hours: getSetting('subs_batch_interval_hours') || '6',
    subs_api_key:           ensureSubsApiKey(), // vises i klartekst — skal tastes ind i webOS-appen
    webif_username:         getSetting('webif_username'),
    webif_password:         getSetting('webif_password_hash') ? '***set***' : '',
  });
});

app.post('/api/settings', (req, res) => {
  if (req.body.subs_api_key !== undefined) {
    const k = String(req.body.subs_api_key || '');
    if (k.length < 6 || k.length > 10) {
      return res.status(400).json({ ok: false, error: 'API key must be 6-10 characters (needs to be entered on the TV remote)' });
    }
  }
  // A bare host:port (no http(s):// scheme) saves without error but silently breaks every
  // extraction — ffmpeg/curl can't resolve a schemeless URL, and the failure only ever surfaces
  // later as a confusing "Command failed: ffmpeg -i ips.example.com/movie/..." deep in an
  // extraction attempt. Auto-prepend http:// so a copy-pasted host:port still works.
  if (typeof req.body.xtream_base === 'string' && req.body.xtream_base && !/^https?:\/\//i.test(req.body.xtream_base)) {
    req.body.xtream_base = 'http://' + req.body.xtream_base;
  }
  // xtream_base/xtream_user must never be silently wiped by an empty submission (e.g. a
  // frontend race where the fields hadn't finished loading yet before Save was clicked) —
  // an empty value here is treated as "no change", same principle as the password fields below.
  const protectFromBlank = ['xtream_base', 'xtream_user', 'xtream_pass'];
  const all = ['xtream_base', 'xtream_user', 'xtream_pass', 'xui_sync_hours',
               'subs_max_bandwidth_mbit', 'subs_auto_enabled', 'subs_batch_interval_hours', 'subs_api_key'];
  for (const f of all) {
    if (req.body[f] !== undefined) {
      if (f === 'xtream_pass' && req.body[f] === '***set***') continue;
      if (protectFromBlank.includes(f) && req.body[f] === '') continue;
      setSetting(f, req.body[f]);
    }
  }
  if (req.body.webif_username !== undefined) setSetting('webif_username', req.body.webif_username);
  if (req.body.webif_password && req.body.webif_password !== '***set***') {
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = hashPassword(req.body.webif_password, salt);
    setSetting('webif_password_hash', hash);
    setSetting('webif_password_salt', salt);
  }
  scheduleJobs();
  res.json({ ok: true });
});

app.post('/api/test-xtream', async (req, res) => {
  try {
    const movies = await getXuiMoviesWithContainer(false);
    if (!movies.length) return res.json({ ok: false, message: 'No movies found on the Xtream panel' });
    const url = buildXtreamMovieUrl(movies[0].id, movies[0].container);
    await ffprobeSubtitleStreams(url);
    res.json({ ok: true, message: `Xtream login OK — tested against "${movies[0].title}"` });
  } catch (e) { res.json({ ok: false, message: e.message }); }
});

// ── Film/serie-lister + status ─────────────────────────────────────────────────
app.get('/api/subs/movies', async (req, res) => {
  try {
    const movies = await getXuiMoviesWithContainer(req.query.force === '1');
    const statusRows = db.prepare('SELECT stream_id, status, languages, error, duration_sec, updated_at FROM vod_subs_status').all();
    const statusMap = {};
    for (const r of statusRows) statusMap[r.stream_id] = r;
    const enriched = movies.map(m => {
      const st = statusMap[m.id];
      return {
        id: m.id, title: m.title, container: m.container, added: m.added,
        status: st ? st.status : 'unknown',
        languages: st && st.languages ? JSON.parse(st.languages) : [],
        error: st ? st.error : null,
        duration_sec: st ? st.duration_sec : null,
        updated_at: st ? st.updated_at : null,
      };
    });
    res.json({ movies: enriched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/subs/episodes', async (req, res) => {
  try {
    const episodes = await getXuiEpisodesWithContainer(req.query.force === '1');
    const statusRows = db.prepare('SELECT id, status, languages, error, duration_sec, updated_at FROM series_subs_status').all();
    const statusMap = {};
    for (const r of statusRows) statusMap[r.id] = r;
    const enriched = episodes.map(ep => {
      const st = statusMap[ep.id];
      return {
        id: ep.id, series_id: ep.series_id, series_name: ep.series_name, season_num: ep.season_num,
        episode_num: ep.episode_num, episode_title: ep.episode_title, container: ep.container, added: ep.added,
        status: st ? st.status : 'unknown',
        languages: st && st.languages ? JSON.parse(st.languages) : [],
        error: st ? st.error : null,
        duration_sec: st ? st.duration_sec : null,
        updated_at: st ? st.updated_at : null,
      };
    });
    res.json({ episodes: enriched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// "Queue" — appends to the back of the queue and returns immediately (does NOT wait for the
// extraction to finish, unlike /api/subs/extract/:type/:id below which jumps the queue and
// waits). Used by the secondary button in the webif — to line up several movies/episodes
// without blocking the UI on each one.
app.post('/api/subs/enqueue/:type/:id', async (req, res) => {
  try {
    const { type } = req.params;
    if (!subsTypeOk(type)) return res.status(400).json({ ok: false, error: 'Invalid type' });
    const id = parseInt(req.params.id, 10);
    let item;
    if (type === 'movie') {
      const movies = await getXuiMoviesWithContainer(false);
      const m = movies.find(x => x.id === id);
      if (!m) return res.status(404).json({ ok: false, error: 'Movie not found' });
      item = { id: m.id, type: 'movie', title: m.title, container: m.container };
    } else {
      const episodes = await getXuiEpisodesWithContainer(false);
      const ep = episodes.find(x => x.id === id);
      if (!ep) return res.status(404).json({ ok: false, error: 'Episode not found' });
      item = {
        id: ep.id, type: 'episode', title: episodeDisplayTitle(ep), container: ep.container,
        series_id: ep.series_id, series_name: ep.series_name, season_num: ep.season_num,
        episode_num: ep.episode_num, episode_title: ep.episode_title, added: ep.added,
      };
    }
    const queued = enqueueSubsExtraction([item]);
    res.json({ ok: true, queued: queued > 0 });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Removes an item from the queue again (before it's reached being the active one) — used by
// the "Remove" button in the queue list in the webif. Doesn't touch an item already running.
app.post('/api/subs/dequeue/:type/:id', (req, res) => {
  const { type } = req.params;
  if (!subsTypeOk(type)) return res.status(400).json({ ok: false, error: 'Invalid type' });
  const id = parseInt(req.params.id, 10);
  const before = subsQueueState.queue.length;
  subsQueueState.queue = subsQueueState.queue.filter(i => !(i.id === id && i.type === type));
  subsQueueState.total = subsQueueState.done + subsQueueState.queue.length + (subsQueueState.running ? 1 : 0);
  res.json({ ok: true, removed: before - subsQueueState.queue.length });
});

app.post('/api/subs/extract/:type/:id', async (req, res) => {
  try {
    const { type } = req.params;
    if (!subsTypeOk(type)) return res.status(400).json({ ok: false, error: 'Invalid type' });
    const id = parseInt(req.params.id, 10);
    if (type === 'movie') {
      const movies = await getXuiMoviesWithContainer(false);
      const m = movies.find(x => x.id === id);
      if (!m) return res.status(404).json({ ok: false, error: 'Movie not found' });
      const result = await enqueueAndWait({ id: m.id, type: 'movie', title: m.title, container: m.container });
      return res.json(result);
    }
    const episodes = await getXuiEpisodesWithContainer(false);
    const ep = episodes.find(x => x.id === id);
    if (!ep) return res.status(404).json({ ok: false, error: 'Episode not found' });
    const result = await enqueueAndWait({
      id: ep.id, type: 'episode', title: episodeDisplayTitle(ep), container: ep.container,
      series_id: ep.series_id, series_name: ep.series_name, season_num: ep.season_num,
      episode_num: ep.episode_num, episode_title: ep.episode_title, added: ep.added,
    });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// "Re-extract" — recovery for a row stuck on 'extracting' (a hung ffmpeg/curl, or a stale row
// left over from a service restart mid-extraction). Force-kills any active attempt and jumps
// the queue with a fresh attempt, regardless of current status.
app.post('/api/subs/reextract/:type/:id', async (req, res) => {
  try {
    const { type } = req.params;
    if (!subsTypeOk(type)) return res.status(400).json({ ok: false, error: 'Invalid type' });
    const id = parseInt(req.params.id, 10);

    let item;
    if (type === 'movie') {
      const movies = await getXuiMoviesWithContainer(false);
      const m = movies.find(x => x.id === id);
      if (!m) return res.status(404).json({ ok: false, error: 'Movie not found' });
      item = { id: m.id, type: 'movie', title: m.title, container: m.container };
    } else {
      const episodes = await getXuiEpisodesWithContainer(false);
      const ep = episodes.find(x => x.id === id);
      if (!ep) return res.status(404).json({ ok: false, error: 'Episode not found' });
      item = {
        id: ep.id, type: 'episode', title: episodeDisplayTitle(ep), container: ep.container,
        series_id: ep.series_id, series_name: ep.series_name, season_num: ep.season_num,
        episode_num: ep.episode_num, episode_title: ep.episode_title, added: ep.added,
      };
    }

    const wasRunning = subsQueueState.currentId === id && subsQueueState.currentType === type;
    if (wasRunning) {
      subsQueueState.currentKilledManually = true;
      try { subsQueueState.currentProc?.kill(); } catch (e) { /* process already dead */ }
    } else {
      const table = type === 'movie' ? 'vod_subs_status' : 'series_subs_status';
      const idCol = type === 'movie' ? 'stream_id' : 'id';
      db.prepare(`UPDATE ${table} SET status='pending', error=NULL, updated_at=? WHERE ${idCol}=?`)
        .run(Math.floor(Date.now() / 1000), id);
    }

    subsQueueState.queue = subsQueueState.queue.filter(i => !(i.id === id && i.type === type));
    subsQueueState.queue.unshift(item);
    subsQueueState.total = subsQueueState.done + subsQueueState.queue.length + (subsQueueState.running ? 1 : 0);
    runSubsQueue();
    res.json({ ok: true, wasRunning });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ?type=movie|episode (default movie)
app.post('/api/subs/extract-batch', async (req, res) => {
  try {
    const type = req.query.type === 'episode' ? 'episode' : 'movie';
    if (type === 'movie') {
      const movies = await getXuiMoviesWithContainer(false);
      const doneIds = new Set(db.prepare(`SELECT stream_id FROM vod_subs_status WHERE status IN ('done','no_subs')`).all().map(r => r.stream_id));
      const todo = movies.filter(m => !doneIds.has(m.id)).map(m => ({ id: m.id, type: 'movie', title: m.title, container: m.container }));
      const queued = enqueueSubsExtraction(todo);
      return res.json({ ok: true, queued });
    }
    const episodes = await getXuiEpisodesWithContainer(false);
    const doneIds = new Set(db.prepare(`SELECT id FROM series_subs_status WHERE status IN ('done','no_subs')`).all().map(r => r.id));
    const todo = episodes.filter(ep => !doneIds.has(ep.id)).map(ep => ({
      id: ep.id, type: 'episode', title: episodeDisplayTitle(ep), container: ep.container,
      series_id: ep.series_id, series_name: ep.series_name, season_num: ep.season_num,
      episode_num: ep.episode_num, episode_title: ep.episode_title, added: ep.added,
    }));
    const queued = enqueueSubsExtraction(todo);
    res.json({ ok: true, queued });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/subs/queue', (req, res) => {
  res.json({
    running: subsQueueState.running,
    current: subsQueueState.current,
    currentId: subsQueueState.currentId,
    currentType: subsQueueState.currentType,
    currentProgressPct: subsQueueState.currentProgressPct,
    done: subsQueueState.done,
    total: subsQueueState.total,
    remaining: subsQueueState.queue.length,
    errors: subsQueueState.errors,
    queueItems: subsQueueState.queue.map(i => ({ id: i.id, type: i.type, title: i.title })),
  });
});

// Emergency stop — kills the actively-tracked extraction (if any), sweeps for orphaned
// ffmpeg/curl processes a service restart may have left running, and resets any DB rows stuck
// on 'extracting' back to 'pending'. Rows belonging to the currently-tracked extraction are left
// alone here — killing its process above already makes extractMovieSubs/extractEpisodeSubs's own
// catch block mark it 'error' (via currentKilledManually), so touching it again here would race
// with that. Does NOT clear the waiting queue — only the active/stuck state.
app.post('/api/subs/kill-all', async (req, res) => {
  try {
    const currentId = subsQueueState.currentId, currentType = subsQueueState.currentType;
    if (subsQueueState.currentProc) {
      subsQueueState.currentKilledManually = true;
      try { subsQueueState.currentProc.kill(); } catch (e) { /* already dead */ }
    }
    await killOrphanedExtractionProcesses();
    const now = Math.floor(Date.now() / 1000);
    const movieRows = db.prepare(
      `UPDATE vod_subs_status SET status='pending', error='Stopped (background cleanup)', updated_at=? WHERE status='extracting' AND NOT (? = 'movie' AND stream_id = ?)`
    ).run(now, currentType, currentId);
    const epRows = db.prepare(
      `UPDATE series_subs_status SET status='pending', error='Stopped (background cleanup)', updated_at=? WHERE status='extracting' AND NOT (? = 'episode' AND id = ?)`
    ).run(now, currentType, currentId);
    res.json({ ok: true, moviesReset: movieRows.changes, episodesReset: epRows.changes });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

async function startup() {
  ffmpegAvailable = await checkFfmpegAvailable();
  if (!ffmpegAvailable) {
    console.error(`[${new Date().toISOString()}] WARNING: ffmpeg check failed (${ffmpegCheckError}) — subtitle extraction will fail until this is resolved and the service is restarted. ENOENT usually means ffmpeg isn't on PATH (or, on an XUI box, that its ffmpeg symlink is dangling); EACCES means the binary exists but isn't executable by this user.`);
  }
  scheduleJobs();
  app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] vtttool listening on port ${PORT}${ffmpegAvailable ? '' : ' (ffmpeg missing!)'}`);
  });
}
startup();
