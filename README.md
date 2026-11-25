# pi-afk

A Pi 1.6 extension that replaces compaction summaries without calling a model. It keeps only this text in the compacted conversation context (Pi still retains its normal system prompt):

> See pi logs uri for more details: {file URI}. user messages: {user messages joined by newlines}, your last response: {last assistant response}.

The JSONL session log remains intact. The summary uses the active branch, including user messages from before earlier compactions. It copies text verbatim, without truncating it or checking whether it fits the context window.

## Install

Install with Git access to the private repository:

```sh
pi install git:github.com/D3MZ/pi-afk
```

To try a local checkout without installing:

```sh
pi -e ./extension.ts
```

## Settings

Add this block to `~/.pi/agent/settings.json` or to a trusted project's `.pi/settings.json`, then run `/reload`:

```json
{
  "piAfk": {
    "enabled": true,
    "idleCompactionMinutes": 5
  }
}
```

- `enabled` defaults to `true`. Set it to `false` to restore Pi's normal compaction and turn off the idle timer.
- `idleCompactionMinutes` defaults to `5`. The timer starts after a turn settles or an uncompacted session is loaded. A new turn resets the idle period. Sessions without a log file are left alone.

Pi's normal manual and automatic compaction checks still apply. Idle compaction writes a native compaction entry directly, so it also works when Pi would decline `/compact` for a short session. The idle path relies on the live session manager exposed by Pi 1.6. It updates the saved session and the next model request, but does not redraw the open transcript.

## Development

```sh
npm ci
npm run typecheck
npm test
```
