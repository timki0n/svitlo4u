#!/usr/bin/env python3
"""Record golden outputs of the legacy svitlo_checker code.

The legacy modules (yasno_outages.py, bot.py) are imported and executed as-is, so the
golden files describe what production actually did — including its bugs. Deliberate
deviations are listed in packages/domain/test/golden/REVIEW.md, not patched here.

Run with the legacy virtualenv (it has aiogram/requests installed):

    <svitlo_checker>/.venv/Scripts/python.exe tools/golden/generate.py --legacy <svitlo_checker>

Python >= 3.10. No network access, no writes outside a temp dir and the golden folder.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import types
from pathlib import Path
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "packages" / "domain" / "test" / "fixtures" / "yasno"
OUT = REPO / "packages" / "domain" / "test" / "golden"

KYIV = ZoneInfo("Europe/Kyiv")
UTC = dt.timezone.utc
STEP_MIN = 5
# Extra samples around every outage edge: catches off-by-one and grace-window boundaries (45/90 min).
PROBE_OFFSETS = (-91, -90, -89, -46, -45, -44, -1, 0, 1, 44, 45, 46, 89, 90, 91)
DST_DATES = {"2026-03-29", "2026-03-30", "2026-10-25", "2026-10-26", "2025-10-26", "2025-10-27"}


# ───────────────────────── legacy loading ─────────────────────────

class _FrozenToday:
    value = dt.date(2026, 1, 1)


class FrozenDate(dt.date):
    """yasno_outages falls back to date.today() when a day has no date; make it deterministic."""

    @classmethod
    def today(cls):  # type: ignore[override]
        return _FrozenToday.value


def load_legacy(legacy: Path):
    workdir = tempfile.mkdtemp(prefix="golden-")
    os.environ["DB_PATH"] = str(Path(workdir) / "legacy.db")  # storage.Database() runs at import
    os.environ["PUSH_SUBS_DB_PATH"] = str(Path(workdir) / "push.db")
    os.environ["TIMELINE_SCREENSHOT_ENABLED"] = "0"
    os.environ["ALERT_CHAT_ID"] = ""
    os.chdir(workdir)
    sys.path.insert(0, str(legacy))

    import yasno_outages  # noqa: E402
    import bot  # noqa: E402

    yasno_outages.dt = types.SimpleNamespace(
        datetime=dt.datetime, date=FrozenDate, time=dt.time, timedelta=dt.timedelta, timezone=dt.timezone
    )

    def no_network(*_a, **_k):
        raise RuntimeError("network access is disabled during golden generation")

    bot.yasno.fetch = no_network
    return yasno_outages, bot


def legacy_commit(legacy: Path) -> str:
    try:
        return subprocess.check_output(["git", "-C", str(legacy), "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


# ───────────────────────── fixtures ─────────────────────────

def kyiv_midnight(date: dt.date) -> dt.datetime:
    return dt.datetime.combine(date, dt.time.min, tzinfo=KYIV)


def api_day(date_str: str, status: str, slots: list[dict]) -> dict:
    return {"date": kyiv_midnight(dt.date.fromisoformat(date_str)).isoformat(), "status": status, "slots": slots}


def history_fixtures() -> list[dict]:
    rows = json.loads((FIXTURES / "history.json").read_text(encoding="utf-8"))["days"]
    by_group: dict[str, dict[str, dict]] = {}
    for row in rows:
        by_group.setdefault(row["group"], {})[row["date"]] = row

    fixtures: list[dict] = []
    seen: dict[str, dict] = {}
    for group, days in sorted(by_group.items()):
        for date_str in sorted(days):
            today = days[date_str]
            next_date = (dt.date.fromisoformat(date_str) + dt.timedelta(days=1)).isoformat()
            tomorrow = days.get(next_date)
            block = {
                "today": api_day(date_str, today["status"], today["slots"]),
                "tomorrow": api_day(next_date, tomorrow["status"], tomorrow["slots"])
                if tomorrow
                else api_day(next_date, "WaitingForSchedule", []),
            }
            pattern = json.dumps(
                [block["today"]["status"], block["today"]["slots"], block["tomorrow"]["status"], block["tomorrow"]["slots"]],
                sort_keys=True,
            )
            if date_str in DST_DATES or next_date in DST_DATES:
                pattern += "|" + date_str  # keep every DST pair
            if pattern in seen:
                seen[pattern]["alsoSeen"] += 1
                continue
            fixture = {
                "id": f"h{group}-{date_str}",
                "source": f"history:{group}:{date_str}",
                "description": None,
                "block": block,
                "alsoSeen": 0,
            }
            seen[pattern] = fixture
            fixtures.append(fixture)
    return fixtures


def live_fixtures() -> list[dict]:
    fixtures = []
    for path in sorted(FIXTURES.glob("live-*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        stamp = path.stem.removeprefix("live-")
        for group in ("12.1", "6.1"):
            if group in data:
                fixtures.append(
                    {"id": f"live{group}-{stamp}", "source": f"live:{path.name}:{group}", "description": None,
                     "block": data[group], "alsoSeen": 0}
                )
    return fixtures


def synthetic_fixtures() -> list[dict]:
    cases = json.loads((FIXTURES / "synthetic.json").read_text(encoding="utf-8"))["cases"]
    return [
        {"id": f"s-{c['id']}", "source": f"synthetic:{c['id']}", "description": c["description"],
         "block": c["block"], "alsoSeen": 0}
        for c in cases
    ]


# ───────────────────────── golden: days ─────────────────────────

def iso(value) -> str | None:
    return value.isoformat() if value is not None else None


def info_json(info: dict) -> dict:
    return {
        "date": iso(info.get("date")),
        "status": info.get("status"),
        "outages": [{"start": iso(o["start"]), "end": iso(o["end"]), "type": o["type"]} for o in info.get("outages", [])],
        "updatedOn": info.get("updated_on"),
    }


def sample_offsets(yasno_mod, block: dict, origin_utc: dt.datetime, total: int) -> list[int]:
    offsets = set(range(0, total, STEP_MIN))
    for key in ("today", "tomorrow"):
        day = block.get(key)
        if not day or not day.get("date"):
            continue
        date = dt.datetime.fromisoformat(day["date"]).date()
        for raw in day.get("slots", []):
            slot = yasno_mod.Slot(raw["start"], raw["end"], raw.get("type", ""))
            if not slot.is_outage:
                continue
            for edge in slot.as_time_range(date, KYIV):
                base = int((edge.astimezone(UTC) - origin_utc).total_seconds() // 60)
                for off in PROBE_OFFSETS:
                    if 0 <= base + off < total:
                        offsets.add(base + off)
    return sorted(offsets)


def run_length(samples: list[int], fn) -> list[list]:
    runs: list[list] = []
    marker = object()
    last = marker
    for minute in samples:
        value = fn(minute)
        if last is marker or value != last:
            runs.append([minute, value])
            last = value
    return runs


def golden_day(yasno_mod, bot, fixture: dict) -> dict:
    block = fixture["block"]
    data = {bot.yasno.group_id: block}
    today_date = dt.datetime.fromisoformat(block["today"]["date"]).date()
    _FrozenToday.value = today_date

    origin = kyiv_midnight(today_date)
    origin_utc = origin.astimezone(UTC)
    end_utc = kyiv_midnight(today_date + dt.timedelta(days=2)).astimezone(UTC)
    total = int((end_utc - origin_utc).total_seconds() // 60)
    samples = sample_offsets(yasno_mod, block, origin_utc, total)

    def at(minute: int) -> dt.datetime:
        return (origin_utc + dt.timedelta(minutes=minute)).astimezone(KYIV)

    today_info = bot.yasno.get_today_outages(data)
    tomorrow_info = bot.yasno.get_tomorrow_outages(data)

    def without_outages(info: dict) -> bool:
        sig = tuple((s.start_min, s.end_min, s.type) for s in info.get("raw_slots") or [])
        return bot._is_schedule_without_outages(info.get("status"), sig)

    segments = bot._extract_plan_segments(today_info, tomorrow_info)
    reminders = bot._build_reminder_events(segments, origin)
    today_body = bot.build_today_message(today_info)
    tomorrow_body = bot.build_today_message(tomorrow_info)

    return {
        "id": fixture["id"],
        "source": fixture["source"],
        "description": fixture["description"],
        "alsoSeen": fixture["alsoSeen"],
        "input": block,
        "originUtc": origin_utc.isoformat().replace("+00:00", "Z"),
        "static": {
            "todayInfo": info_json(today_info),
            "tomorrowInfo": info_json(tomorrow_info),
            "todayBody": today_body,
            "tomorrowBody": tomorrow_body,
            "todayCommand": bot.with_last_schedule_update(today_body, today_info),
            "tomorrowCommand": bot.with_last_schedule_update(tomorrow_body, tomorrow_info),
            "todayWithoutOutages": without_outages(today_info),
            "tomorrowWithoutOutages": without_outages(tomorrow_info),
            "planSegments": [[iso(s), iso(e)] for s, e in segments],
            "remindersAtOrigin": {
                "fields": ["kind", "leadMinutes", "triggerAt", "start", "end", "durationMinutes"],
                "rows": [
                    [r.kind, r.lead_minutes, iso(r.trigger_at), iso(r.start), iso(r.end), r.duration_minutes]
                    for r in reminders
                ],
            },
        },
        "samples": samples,
        "timeline": {
            "nearestRestoreMessage": run_length(
                samples, lambda m: bot.yasno.get_nearest_restore_message(now=at(m), data_override=data)),
            "nearestOutageMessage": run_length(
                samples, lambda m: bot.yasno.get_nearest_outage_message(now=at(m), data_override=data)),
            "nearestOutage": run_length(
                samples, lambda m: iso(bot.yasno.get_nearest_outage(now=at(m), data_override=data))),
        },
    }


# ───────────────────────── golden: schedule monitors ─────────────────────────

D1, D2, D3 = "2026-11-10T00:00:00+02:00", "2026-11-11T00:00:00+02:00", "2026-11-12T00:00:00+02:00"
NP_ALL = [(0, 1440, "NotPlanned")]
A = [(0, 480, "NotPlanned"), (480, 720, "Definite"), (720, 1440, "NotPlanned")]
B = [(0, 480, "NotPlanned"), (480, 780, "Definite"), (780, 1440, "NotPlanned")]


def day(date: str, status: str, slots) -> dict:
    return {"date": date, "status": status, "slots": [{"start": a, "end": b, "type": t} for a, b, t in slots]}


MONITOR_SCENARIOS = [
    ("today", "first-run", "First poll only sets the baseline", [day(D1, "ScheduleApplies", A)]),
    ("today", "unchanged", "Same schedule twice", [day(D1, "ScheduleApplies", A), day(D1, "ScheduleApplies", A)]),
    ("today", "slots-changed", "Outage window moved", [day(D1, "ScheduleApplies", A), day(D1, "ScheduleApplies", B)]),
    ("today", "applies-empty-to-no-outages", "Empty ScheduleApplies -> NoOutages",
     [day(D1, "ScheduleApplies", []), day(D1, "NoOutages", NP_ALL)]),
    ("today", "applies-notplanned-to-no-outages", "ScheduleApplies with only NotPlanned -> NoOutages",
     [day(D1, "ScheduleApplies", NP_ALL), day(D1, "NoOutages", NP_ALL)]),
    ("today", "no-outages-to-applies", "Outages added", [day(D1, "NoOutages", NP_ALL), day(D1, "ScheduleApplies", A)]),
    ("today", "applies-to-emergency", "Emergency declared", [day(D1, "ScheduleApplies", A), day(D1, "EmergencyShutdowns", [])]),
    ("today", "emergency-to-applies", "Emergency lifted", [day(D1, "EmergencyShutdowns", []), day(D1, "ScheduleApplies", A)]),
    ("today", "waiting-to-applies", "Today published late", [day(D1, "WaitingForSchedule", []), day(D1, "ScheduleApplies", A)]),
    ("today", "waiting-to-no-outages", "Today published as NoOutages",
     [day(D1, "WaitingForSchedule", []), day(D1, "NoOutages", NP_ALL)]),
    ("today", "day-rollover", "Midnight: new day with a different schedule",
     [day(D1, "ScheduleApplies", A), day(D2, "ScheduleApplies", B)]),
    ("today", "rollover-then-change", "Change after midnight is reported",
     [day(D1, "ScheduleApplies", A), day(D2, "ScheduleApplies", B), day(D2, "ScheduleApplies", A)]),
    ("tomorrow", "first-run", "First poll only sets the baseline", [day(D2, "ScheduleApplies", A)]),
    ("tomorrow", "waiting-to-applies", "Tomorrow published", [day(D2, "WaitingForSchedule", []), day(D2, "ScheduleApplies", A)]),
    ("tomorrow", "waiting-to-no-outages", "Tomorrow published without outages",
     [day(D2, "WaitingForSchedule", []), day(D2, "NoOutages", NP_ALL)]),
    ("tomorrow", "waiting-to-applies-empty", "Tomorrow published as empty ScheduleApplies",
     [day(D2, "WaitingForSchedule", []), day(D2, "ScheduleApplies", [])]),
    ("tomorrow", "applies-slots-changed", "Published tomorrow schedule changes",
     [day(D2, "ScheduleApplies", A), day(D2, "ScheduleApplies", B)]),
    ("tomorrow", "waiting-to-emergency", "Tomorrow becomes emergency",
     [day(D2, "WaitingForSchedule", []), day(D2, "EmergencyShutdowns", [])]),
    ("tomorrow", "emergency-to-applies", "Emergency tomorrow replaced by a schedule",
     [day(D2, "EmergencyShutdowns", []), day(D2, "ScheduleApplies", A)]),
    ("tomorrow", "applies-waiting-applies", "Withdrawn and republished",
     [day(D2, "ScheduleApplies", A), day(D2, "WaitingForSchedule", []), day(D2, "ScheduleApplies", B)]),
    ("tomorrow", "rollover-published", "Midnight: the new tomorrow is already published",
     [day(D2, "WaitingForSchedule", []), day(D3, "ScheduleApplies", A)]),
]


async def drive_monitor(bot, kind: str, snapshots: list[dict]) -> list[dict]:
    group = bot.yasno.group_id
    getter = bot.yasno.get_today_outages if kind == "today" else bot.yasno.get_tomorrow_outages
    infos = []
    for snap in snapshots:
        _FrozenToday.value = dt.datetime.fromisoformat(snap["date"]).date()
        infos.append(getter({group: {"today": snap, "tomorrow": snap}}))

    bot.last_today_signature = bot.last_today_date = None
    bot.last_tomorrow_status = bot.last_tomorrow_date = None
    queue = iter(infos)
    current: dict[str, list] = {"telegram": [], "web": []}
    iterations: list[dict] = []
    real_sleep = asyncio.sleep

    async def fake_notify(_bot, text, photo_path=None):
        current["telegram"].append(text)

    async def fake_web(payload):
        current["web"].append(payload)

    async def fake_noop(*_a, **_k):
        return None

    async def fake_sleep(_seconds):
        await real_sleep(0)
        await real_sleep(0)
        iterations.append({"telegram": list(current["telegram"]), "web": list(current["web"])})
        current["telegram"].clear()
        current["web"].clear()
        if len(iterations) >= len(infos):
            raise asyncio.CancelledError

    patched = {
        "notify": bot.notify, "web_notify": bot.web_notify,
        "create_schedule_screenshot": bot.create_schedule_screenshot,
    }
    attr = "get_today_outages" if kind == "today" else "get_tomorrow_outages"
    setattr(bot.yasno, attr, lambda *a, **k: next(queue))
    bot.notify, bot.web_notify, bot.create_schedule_screenshot = fake_notify, fake_web, fake_noop
    original_upsert = bot.db.upsert_schedule
    bot.db.upsert_schedule = fake_noop
    asyncio.sleep = fake_sleep
    try:
        monitor = bot.schedule_monitor if kind == "today" else bot.schedule_monitor_tomorrow
        await monitor(None)
    finally:
        asyncio.sleep = real_sleep
        delattr(bot.yasno, attr)
        bot.db.upsert_schedule = original_upsert
        for name, value in patched.items():
            setattr(bot, name, value)
    return iterations


def golden_monitors(bot) -> dict:
    scenarios = []
    for kind, sid, description, snapshots in MONITOR_SCENARIOS:
        iterations = asyncio.run(drive_monitor(bot, kind, snapshots))
        scenarios.append({"id": f"{kind}:{sid}", "monitor": kind, "description": description,
                          "snapshots": snapshots, "iterations": iterations})
    return {"scenarios": scenarios}


# ───────────────────────── golden: formatting ─────────────────────────

def golden_formatting(bot) -> dict:
    seconds = [0, 30, 59, 60, 61, 119, 120, 300, 3599, 3600, 3660, 3720, 7200, 7260, 18000, 86399, 86400,
               90000, 90060, 172800, 259200, 345600, 432000, 1814400, 1900800, 8640000]
    base = dt.datetime(2026, 11, 10, tzinfo=KYIV)
    spans = [(0, 30), (0, 60), (0, 90), (30, 45), (0, 1440), (120, 300), (0, 0)]
    updates = ["2026-11-06T10:31:44+00:00", "2026-03-29T00:30:00+00:00", "2026-10-25T00:30:00+00:00",
               "2026-01-01T00:00:00+02:00", "2026-12-31T23:59:59+00:00", "not-a-date", "", None]
    return {
        "fmtDurationLong": [[s, bot.fmt_duration_long(s)] for s in seconds],
        "formatDuration": [
            [a, b, bot.format_duration(base + dt.timedelta(minutes=a), base + dt.timedelta(minutes=b))] for a, b in spans
        ],
        "formatLastScheduleUpdate": [[u, bot.format_last_schedule_update(u)] for u in updates],
        "formatLeadLabel": [[m, bot._format_lead_label(m)] for m in (10, 20, 30, 45, 60, 90, 120)],
    }


# ───────────────────────── main ─────────────────────────

_SCALAR_ARRAY = re.compile(r"\[\n\s*([^\[\]{}]*?)\n\s*\]")


def write_json(path: Path, payload) -> None:
    """Pretty JSON, but arrays of scalars (samples, [minute, value] runs) stay on one line."""
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    text = _SCALAR_ARRAY.sub(lambda m: "[" + re.sub(r",\n\s*", ", ", m.group(1)) + "]", text)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n", encoding="utf-8", newline="\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--legacy", required=True, type=Path, help="Path to the svitlo_checker checkout")
    args = parser.parse_args()
    legacy = args.legacy.resolve()
    commit = legacy_commit(legacy)

    yasno_mod, bot = load_legacy(legacy)

    fixtures = history_fixtures() + live_fixtures() + synthetic_fixtures()
    days_dir = OUT / "days"
    if days_dir.exists():
        for old in days_dir.glob("*.json"):
            old.unlink()
    index = []
    for fixture in fixtures:
        golden = golden_day(yasno_mod, bot, fixture)
        write_json(days_dir / f"{fixture['id']}.json", golden)
        index.append({"id": fixture["id"], "source": fixture["source"], "alsoSeen": fixture["alsoSeen"]})

    write_json(OUT / "monitor-transitions.json", golden_monitors(bot))
    write_json(OUT / "formatting.json", golden_formatting(bot))
    write_json(OUT / "index.json", {
        "legacyCommit": commit,
        "python": sys.version.split()[0],
        "stepMinutes": STEP_MIN,
        "probeOffsets": list(PROBE_OFFSETS),
        "days": index,
    })
    print(f"days={len(index)} monitors={len(MONITOR_SCENARIOS)} legacy={commit[:7]} -> {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
