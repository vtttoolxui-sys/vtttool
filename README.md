# vtttool

A standalone tool that extracts subtitles from video streams on an Xtream/XUI
server (IPTV panel) so they can be used by a webOS app. The webOS client can't
pull subtitles out of MKV files itself without streaming the whole file through
a second time in parallel with playback (double bandwidth/load) — so ffmpeg
runs server-side instead (once per movie/episode), and the result is saved as
small `.vtt` files that the app fetches directly afterwards.

Uses exclusively the Xtream API (`player_api.php`) to fetch the movie/episode
lists — not a direct database connection to XUI.

## How it works

1. The movie/episode list is fetched from the Xtream panel's `player_api.php`
   (`get_vod_streams` / `get_series` + `get_series_info`), cached locally in
   SQLite.
2. When you extract a title, vtttool builds the same kind of playback URL the
   TV app itself would use (`<xtream_base>/movie/<user>/<pass>/<id>.<ext>` or
   `/series/...` for episodes) and runs `ffmpeg -i <url>` against it to detect
   which subtitle streams the file contains, and their languages.
3. All requested subtitle streams are pulled out in a single ffmpeg pass
   (`-map 0:<index> -c:s webvtt`) and converted straight to WebVTT — no full
   download/transcode of the video itself.
4. Only one extraction runs at a time system-wide, through a shared queue —
   extractions can be run immediately (jumps the queue, blocks until done) or
   queued (appended to the back, returns immediately); the webif shows live
   progress per item plus a queue panel.
5. The resulting `.vtt` files are served back over HTTP, protected by a
   separate API key so a TV app can fetch them without a full webif login
   (see "TV app access" below).

## Where subtitles are stored

```
data/subs/movies/<stream_id>/<lang>.vtt    – one file per language, per movie
data/subs/series/<episode_id>/<lang>.vtt   – one file per language, per episode
```

`<lang>` is the 3-letter language code ffmpeg reports for that subtitle stream
(e.g. `eng`, `dan`). `data/` (including the SQLite database) is not tracked in
git — see `.gitignore`.

## Run it yourself

```
npm install
node server.js
```

Listens on the port from the `PORT` env var, defaults to **35600** if unset.

## Access

- Webif: `http://<server>:PORT`
- **Default login: username `vtttool`, password `vtttool`**
  Change it under the Settings tab in the webif (or `POST /api/settings` with
  `webif_username`/`webif_password`). Set an empty username to disable login
  entirely.

## Configuration (under Settings in the webif)

- **Xtream login** (`xtream_base`, `xtream_user`, `xtream_pass`) — the panel's
  regular stream login, the same kind of URL the TV app itself uses
- **API key** (`subs_api_key`, 6-10 characters) — entered in the TV app,
  protects the `/subs-*` endpoints which otherwise have no login
- Max bandwidth per extraction, auto-extract on/off + interval

## TV app access

A webOS (or any other) TV app doesn't log in with the webif username/password
— it authenticates with the separate `subs_api_key` instead, passed as a `key`
query parameter, since HTML5's `<track src>` can't send custom headers, only a
plain URL:

1. `GET /subs-ping?key=<subs_api_key>` — health check, confirms the key is
   valid
2. Before playback: `GET /subs-info/movie/<stream_id>?key=<subs_api_key>` →
   `{status, languages}` (use `episode` + episode id for series)
3. If `status` is `"done"`, fetch each language directly:
   `GET /subs/movie/<stream_id>/<lang>.vtt?key=<subs_api_key>` and use it as
   `<track src=...>` in the video player

No other endpoint requires this key — everything under `/api/*` and the webif
itself uses the separate username/password login instead.

## Structure

```
server.js          – all backend logic
public/index.html  – frontend (admin UI)
data/               – SQLite database + extracted .vtt files (not in git)
```
