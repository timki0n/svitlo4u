# Golden outputs of the legacy code

Recorded behaviour of the legacy Python implementation (`svitlo_checker`, commit in `index.json`).
The new TypeScript domain must reproduce it, **except** for deliberate deviations approved in
[REVIEW.md](REVIEW.md) — the legacy code was not always right.

## Contents

| File | What it records |
|---|---|
| `days/*.json` | One Yasno group block (today + tomorrow) → parsed day info, `/today` and `/tomorrow` texts, plan segments, reminder events, and three time-dependent functions sampled over 48 h |
| `monitor-transitions.json` | Sequences of schedule snapshots fed through the real `schedule_monitor` / `schedule_monitor_tomorrow` loops → which polls produced Telegram/web notifications and their texts |
| `formatting.json` | Duration, lead-time and "last update" formatting |
| `index.json` | Legacy commit, sampling parameters, list of day fixtures |

Day fixtures come from `../fixtures/yasno/`: production history of groups 12.1 and 6.1 (deduplicated —
`alsoSeen` counts identical days), live API snapshots, and hand-made edge cases (`s-*`).

### Day file format

- `originUtc` — local midnight of "today" in UTC. `samples` — minutes from it in **absolute** time
  (every 5 min plus probes at ±1/45/90 min around every outage edge).
- `timeline.<fn>` — run-length encoded: `[minute, value]` means the value holds for that sample and all
  following samples until the next run. Expand over `samples` to get the value at every sample.
- Both days stay fixed for all 48 h, so samples on day 2 show how the functions behave with stale data
  (e.g. right after midnight before Yasno rolls over).
- `static.remindersAtOrigin` — reminder events computed at `originUtc` (`fields` names the row columns).

## Regenerate

```bash
<svitlo_checker>/.venv/Scripts/python.exe tools/golden/generate.py --legacy <svitlo_checker>
```

The generator imports the legacy modules unchanged, disables network access, points the legacy DB to a
temp dir and freezes `date.today()` to the fixture's day. Output is deterministic; re-running must not
change any file. Never edit golden files by hand — record a deviation in REVIEW.md instead.
