# Logs & Reporting Issues

When something misbehaves, Juggler's logs are the fastest way to see what
happened. They live in **one folder tree** so a bug report is a single folder
to zip.

## Where the logs are

Logs live in your platform's standard application-log directory — on macOS that
means **Console.app shows them live** under "Log Reports":

| Platform | Log directory |
|----------|---------------|
| macOS    | `~/Library/Logs/Juggler/` |
| Linux    | `~/.local/state/juggler/logs/` (or `$XDG_STATE_HOME/juggler/logs/`) |
| Windows  | `%LOCALAPPDATA%\Juggler\Logs\` |

They are deliberately kept **out of `~/.juggler/`** so that folder (config,
credentials, sessions) stays copyable without dragging logs along.

The desktop app's log is a flat file; everything for one project's server lives
in that project's own folder:

```
<log directory>/
├── app.log                       the desktop app (window management, server spawning)
├── myproject-a1b2c3d4/           one folder per project
│   ├── server.log                the server working on that project
│   ├── server.stderr.log         raw crash output (panics) for that server
│   └── conversations/
│       ├── conv_k3f9d8a2x.log    one log per conversation (tab)
│       └── conv_m7p1q5z0w.log
└── host/                         a server started with no project ("host" launch)
    ├── server.log
    ├── server.stderr.log
    └── conversations/
```

**One process writes one project folder.** Each project's folder is named after
the project's last path segment plus a short hash of its full path, so two
projects called `app` never collide. Run Juggler on three projects at once and
you get three independent folders; they never interleave, so a line in a log
always belongs to exactly one instance.

- **`<project>-<hash>/server.log`** — the main, structured process log: startup,
  errors, HTTP/WebSocket, lifecycle, and (in verbose mode) debug detail. It
  carries every conversation's activity interleaved, so it's the one to grab for
  a cross-conversation or whole-process issue.
- **`<project>-<hash>/conversations/conv_*.log`** — one file per conversation,
  named by its stable conversation id, holding just that conversation's worker
  activity. Open this to read a single conversation in isolation. Its lines also
  appear in `server.log`, so nothing is lost there.
- **`<project>-<hash>/server.stderr.log`** — a raw catch-all for crashes.
  Normally near-empty; it only fills up if the server panics or fails before
  structured logging starts. Worth including in a bug report anyway.
- **`app.log`** — the desktop app itself: which windows opened, which servers it
  spawned, single-instance handoff. Check this when a **window** won't appear.

Each file opens with a one-line header identifying the instance, e.g.:

```
===== juggler component=server pid=48213 gen=0 project=/Users/you/code/app =====
```

`gen` is the watchdog re-exec generation: if the server recovers from a hang by
relaunching itself in place, the new generation writes a fresh header, so you
can tell pre- and post-recovery lines apart within the same file.

## Reporting an issue

Zip the whole logs folder and attach it (macOS shown; on Linux use
`~/.local/state/juggler/logs`, on Windows zip `%LOCALAPPDATA%\Juggler\Logs`):

```bash
zip -r juggler-logs.zip ~/Library/Logs/Juggler
```

If you can reproduce the problem, reproduce it **first**, then zip — the
relevant lines will be at the end of the matching log. For a project-specific
issue, the folder whose name starts with your project's directory name is the
one that matters; within it, `server.log` for anything process-wide or
`conversations/<id>.log` for a single conversation.

## Verbose logging

For more detail on the console and in the file, start the server with
`--verbose` (or `-v`), or set `"verbose": true` in the project's
`.juggler/config.json`. Debug lines always go to the file; `--verbose` also
surfaces them on the console.

## Rotation & retention

Two independent limits keep the folder bounded:

- **Size rotation** caps each *live* log. When a log reaches the size cap it's
  renamed with a `.1` suffix (and `.1` → `.2`, …); the oldest beyond the backup
  count is dropped. Defaults: **10 MB** per file, **5** backups.
- **Age sweep** caps the *count* of dead logs. At startup Juggler removes any log
  file in the directory that hasn't been modified in **14 days** — so logs for a
  project you stopped using (or a one-off run) age out instead of piling up
  forever. A log you're actively using keeps a current modification time and is
  never swept.

Tune or disable per project in `.juggler/config.json`:

```json
{
  "logging": {
    "max_size_mb": 10,
    "max_backups": 5,
    "max_age_days": 14,
    "disabled": false
  }
}
```

Set `"max_age_days"` to a negative value to keep logs indefinitely, or
`"disabled": true` to turn off on-disk logging entirely (console only).

The log directory itself can be redirected by setting the `JUGGLER_LOG_DIR`
environment variable — used mainly by the test suite so test runs never write
into your real application-log directory.
