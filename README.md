# vtttool

A standalone tool that extracts subtitles from video streams on an Xtream/XUI
server (IPTV panel) so they can be used by a webOS app. The webOS client can't
pull subtitles out of MKV files itself without streaming the whole file through
a second time in parallel with playback (double bandwidth/load) — so ffmpeg
runs server-side instead (once per movie/episode), and the result is saved as
small `.vtt` files that the app fetches directly afterwards.

Uses exclusively the Xtream API (`player_api.php`) to fetch the movie/episode
lists — not a direct database connection to XUI.

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
- **API key** (`subs_api_key`, 6-10 characters) — entered in the webOS app,
  protects the `/subs-*` endpoints which otherwise have no login
- Max bandwidth per extraction, auto-extract on/off + interval

## Structure

```
server.js          – all backend logic
public/index.html  – frontend (admin UI)
data/               – SQLite database + extracted .vtt files (not in git)
```

See `CLAUDE.md` for full technical documentation, server access, and the
deployment workflow.
