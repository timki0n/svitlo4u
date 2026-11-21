// Світло4U — віджет для iPhone і iPad у безкоштовному застосунку Scriptable.
// Як поставити: сайт будинку → «Про проєкт» → «Віджет на iPhone».
// Інший будинок: у налаштуваннях віджета в полі Parameter впишіть його адресу, напр. svitlo4u.info/4u.

const SITE = "4u";
const ORIGIN = "https://svitlo4u.info";

const MINUTE = 60 * 1000;

/** The site's colours (one dark theme): orange is light, blue is no light. */
const C = {
  bgTop: new Color("#303238"),
  bgBottom: new Color("#25272c"),
  well: new Color("#1c1d21"),
  text: new Color("#f2efea"),
  muted: new Color("#a3a5ad"),
  light: new Color("#ff9a3d"),
  fact: new Color("#ff8a2a"),
  off: new Color("#6c7fa6"),
  cool: new Color("#8fa3c8"),
  warn: new Color("#ff6b57"),
  hatch: new Color("#8fa3c8", 0.6),
  hatchFill: new Color("#6c7fa6", 0.28),
  hatchEdge: new Color("#8fa3c8", 0.75),
  lastEdge: new Color("#a3a5ad", 0.45),
  stripes: new Color("#ff6b57", 0.3),
  future: new Color("#a3a5ad", 0.45),
  now: new Color("#f2efea"),
};

/** Strips of a day: the plan on the upper lane, what really happened on the lower one. */
const SMALL_STRIP = { width: 130, height: 18, radius: 6, padX: 5, plan: [3, 4], fact: [9.5, 5] };
const MEDIUM_STRIP = { width: 310, height: 28, radius: 9, padX: 8, plan: [5, 6], fact: [14, 9] };
const WIDE_STRIP = { width: 310, height: 32, radius: 10, padX: 9, plan: [6, 7], fact: [16, 10] };
const PLAN_STRIP = { width: 310, height: 24, radius: 9, padX: 9, plan: [6, 12], fact: null };

// Times as in Kyiv, whatever the phone's zone (older iOS knows the zone as Europe/Kiev).
const TZ = (() => {
  for (const zone of ["Europe/Kyiv", "Europe/Kiev"]) {
    try {
      new Intl.DateTimeFormat("uk-UA", { timeZone: zone });
      return zone;
    } catch (_) {}
  }
  return undefined;
})();
const TIME = new Intl.DateTimeFormat("uk-UA", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: TZ,
});
const DATE = new Intl.DateTimeFormat("uk-UA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: TZ,
});

function hhmm(ms) {
  return TIME.format(new Date(ms));
}

function dateParts(ms) {
  const parts = {};
  for (const part of DATE.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return parts;
}

function dayNumber(ms) {
  const p = dateParts(ms);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / (24 * 60 * MINUTE);
}

/** «16 год. 34 хв.», as on the site. */
function duration(ms) {
  const minutes = Math.floor(ms / MINUTE);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} хв.`;
  return m === 0 ? `${h} год.` : `${h} год. ${m} хв.`;
}

/** «з 14:58», «з учора, 22:10», «з 19.11, 22:10». */
function sinceText(since, now) {
  const days = dayNumber(now) - dayNumber(since);
  const time = hhmm(since);
  if (days <= 0) return `з ${time}`;
  if (days === 1) return `з учора, ${time}`;
  const p = dateParts(since);
  return `з ${p.day}.${p.month}, ${time}`;
}

/** The widget's Parameter: a building's id or its address on the site; empty — the default. */
function siteFromParameter(parameter) {
  const raw = String(parameter || "")
    .trim()
    .toLowerCase()
    .replace(/[#?].*$/, "");
  const last = raw.split("/").filter(Boolean).pop() || "";
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(last) ? last : SITE;
}

/** The widget's data, or the last one saved when there is no connection. */
async function load(site) {
  const files = FileManager.local();
  const path = files.joinPath(files.cacheDirectory(), `svitlo4u-${site}.json`);
  try {
    const request = new Request(`${ORIGIN}/api/v1/sites/${site}/widget`);
    request.timeoutInterval = 15;
    const data = await request.loadJSON();
    const status = request.response ? request.response.statusCode : 0;
    if (status === 404) return { missing: true };
    if (status === 200 && data && data.timeline) {
      files.writeString(path, JSON.stringify(data));
      return { data, fresh: true };
    }
    console.log(`Світло4U: HTTP ${status}`);
  } catch (error) {
    console.log(`Світло4U: ${error}`);
  }
  try {
    if (files.fileExists(path)) return { data: JSON.parse(files.readString(path)), fresh: false };
  } catch (error) {
    console.log(`Світло4U: ${error}`);
  }
  return {};
}

function isEmergency(day) {
  return day.overlay === "emergency" || day.status === "EmergencyShutdowns";
}

function dayBounds(day) {
  return { start: day.segments[0].start, end: day.segments[day.segments.length - 1].end };
}

/** What the layouts show, from the API's widget data. */
function view(data, now, fresh) {
  const days = data.timeline.days.filter((day) => day.segments.length > 0);
  const index = days.findIndex((day) => {
    const { start, end } = dayBounds(day);
    return start <= now && now < end;
  });
  const today = index >= 0 ? days[index] : null;
  const after = index >= 0 ? days[index + 1] || null : null;
  // tomorrow only when there is something to say: a schedule, or emergency shutdowns
  const tomorrow = after && (hasPlan(after) || isEmergency(after)) ? after : null;
  const emergency = today !== null && isEmergency(today);
  const next = data.next && data.next.at > now ? data.next : null;
  let note = null;
  if (emergency) note = { text: "Екстрені відключення", color: C.warn };
  else if (next) note = { text: next.label, color: C.text };
  else if (data.power === "off") note = { text: "Коли повернуть — невідомо", color: C.muted };
  return {
    now,
    fresh,
    name: data.name,
    updated: data.now,
    power: data.power,
    title: data.title,
    tone: data.power === "on" ? C.light : data.power === "off" ? C.cool : C.muted,
    since:
      data.power !== "unknown" && data.since !== null
        ? sinceText(data.since, now)
        : "датчик не відповідає",
    next,
    note,
    // the corner says when the data is old
    corner: fresh ? data.name : `дані на ${hhmm(data.now)}`,
    today,
    tomorrow,
    actual: data.timeline.actual,
  };
}

/** «Завтра: 08:00–12:00, 16:00–20:00» and the like, for the medium widget. */
function tomorrowText(day) {
  if (isEmergency(day)) return "Завтра: екстрені відключення";
  const off = day.segments.filter((s) => s.kind === "off");
  if (off.length > 0) return `Завтра: ${off.map((s) => s.label).join(", ")}`;
  return "Завтра відключень не заплановано";
}

function hasPlan(day) {
  return day.status === "ScheduleApplies" || day.status === "NoOutages";
}

// ── drawing ─────────────────────────────────────────────────────────────────────────────────

/** A rounded rect; CoreGraphics refuses corners wider than half the rect. */
function roundedPath(rect, radius) {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  const path = new Path();
  path.addRoundedRect(rect, r, r);
  return path;
}

function fillRounded(ctx, rect, radius, color) {
  ctx.addPath(roundedPath(rect, radius));
  ctx.setFillColor(color);
  ctx.fillPath();
}

function strokeRounded(ctx, rect, radius, color, width) {
  const inset = new Rect(
    rect.x + width / 2,
    rect.y + width / 2,
    Math.max(0, rect.width - width),
    Math.max(0, rect.height - width),
  );
  ctx.addPath(roundedPath(inset, radius - width / 2));
  ctx.setStrokeColor(color);
  ctx.setLineWidth(width);
  ctx.strokePath();
}

/** Diagonal stripes («/») inside a rect. */
function hatch(ctx, rect, color, width, gap) {
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.width;
  const y1 = rect.y + rect.height;
  const path = new Path();
  for (let k = x0 + y0 + gap / 2; k < x1 + y1; k += gap) {
    const from = Math.max(x0, k - y1);
    const to = Math.min(x1, k - y0);
    if (to - from < 0.3) continue;
    path.move(new Point(from, k - from));
    path.addLine(new Point(to, k - to));
  }
  ctx.addPath(path);
  ctx.setStrokeColor(color);
  ctx.setLineWidth(width);
  ctx.strokePath();
}

function dashes(ctx, from, to, y, color) {
  const path = new Path();
  for (let x = from; x < to; x += 5) {
    path.move(new Point(x, y));
    path.addLine(new Point(Math.min(x + 2.5, to), y));
  }
  ctx.addPath(path);
  ctx.setStrokeColor(color);
  ctx.setLineWidth(1.5);
  ctx.strokePath();
}

/** Light and no light from the start of the day to `end`, by the real outages. */
function factPieces(start, end, actual, now) {
  const offs = actual
    .map((o) => ({
      start: Math.max(o.start, start),
      end: Math.min(o.end === null ? now : o.end, end),
    }))
    .filter((o) => o.end > o.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const o of offs) {
    const last = merged[merged.length - 1];
    if (last && o.start <= last.end) last.end = Math.max(last.end, o.end);
    else merged.push({ start: o.start, end: o.end });
  }
  const pieces = [];
  let cursor = start;
  for (const o of merged) {
    if (o.start > cursor) pieces.push({ start: cursor, end: o.start, kind: "on" });
    pieces.push({ start: o.start, end: o.end, kind: "off" });
    cursor = o.end;
  }
  if (cursor < end) pieces.push({ start: cursor, end, kind: "on" });
  return pieces;
}

/** A day as on the site's «Зараз»: planned outages hatched, the fact under them, «now» across. */
function strip(day, actual, now, shape) {
  const { width, height, radius, padX } = shape;
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const { start, end } = dayBounds(day);
  const inner = width - 2 * padX;
  const x = (t) => padX + ((Math.min(Math.max(t, start), end) - start) / (end - start)) * inner;
  const emergency = isEmergency(day);

  fillRounded(ctx, new Rect(0, 0, width, height), radius, C.well);
  // emergency shutdowns: red stripes over the day, the last schedule only outlined
  if (emergency) hatch(ctx, new Rect(radius / 2, 0, width - radius, height), C.stripes, 2.5, 9);

  const [planY, planH] = shape.plan;
  for (const s of day.segments) {
    if (s.kind !== "off") continue;
    const rect = new Rect(x(s.start), planY, Math.max(1.5, x(s.end) - x(s.start)), planH);
    if (emergency) {
      strokeRounded(ctx, rect, 3, C.lastEdge, 1);
    } else {
      fillRounded(ctx, rect, 3, C.hatchFill);
      hatch(ctx, rect, C.hatch, 1.2, 4.5);
      strokeRounded(ctx, rect, 3, C.hatchEdge, 1);
    }
  }

  if (shape.fact) {
    const [factY, factH] = shape.fact;
    const pastEnd = Math.min(Math.max(now, start), end);
    if (pastEnd > start) {
      for (const p of factPieces(start, pastEnd, actual, now)) {
        const from = x(p.start) + 0.5;
        const to = x(p.end) - 0.5;
        if (to - from < 0.5) continue;
        const color = p.kind === "on" ? C.fact : C.off;
        fillRounded(ctx, new Rect(from, factY, to - from, factH), 3, color);
      }
    }
    if (now < end) dashes(ctx, x(Math.max(now, start)) + 3, x(end), factY + factH / 2, C.future);
    if (now >= start && now < end)
      fillRounded(ctx, new Rect(x(now) - 1, 1, 2, height - 2), 1, C.now);
  }
  return ctx.getImage();
}

// ── layout ──────────────────────────────────────────────────────────────────────────────────

function font(size, weight) {
  const names = {
    bold: ["boldRoundedSystemFont", "boldSystemFont"],
    semibold: ["semiboldRoundedSystemFont", "semiboldSystemFont"],
  }[weight] || ["mediumRoundedSystemFont", "mediumSystemFont"];
  const name = typeof Font[names[0]] === "function" ? names[0] : names[1];
  return Font[name](size);
}

function label(stack, text, size, color, weight) {
  const item = stack.addText(text);
  item.font = font(size, weight);
  item.textColor = color;
  item.lineLimit = 1;
  item.minimumScaleFactor = 0.6;
  return item;
}

/** Text pushed to the right edge of a vertical stack. */
function trailing(stack, text, size, color, weight, lines) {
  const row = stack.addStack();
  row.layoutHorizontally();
  row.addSpacer();
  const item = label(row, text, size, color, weight);
  item.lineLimit = lines || 1;
  item.rightAlignText();
  return item;
}

function centered(stack) {
  const row = stack.addStack();
  row.layoutHorizontally();
  row.addSpacer();
  const inner = row.addStack();
  row.addSpacer();
  return inner;
}

function bulb(stack, power, size, color) {
  const name =
    power === "on" ? "lightbulb.fill" : power === "off" ? "lightbulb.slash" : "questionmark.circle";
  const symbol = SFSymbol.named(name);
  if (!symbol) return;
  symbol.applyFont(Font.semiboldSystemFont(size));
  const image = stack.addImage(symbol.image);
  image.imageSize = new Size(size, size);
  image.tintColor = color;
}

function picture(stack, image) {
  const item = stack.addImage(image);
  item.resizable = true;
  return item;
}

function hours(stack) {
  const row = stack.addStack();
  row.layoutHorizontally();
  row.setPadding(2, 4, 0, 4);
  ["00", "06", "12", "18", "24"].forEach((hour, i) => {
    if (i > 0) row.addSpacer();
    label(row, hour, 10, C.muted);
  });
}

/** Status at the left, the building (or how old the data is) and the next change at the right. */
function header(w, v, titleSize, corner) {
  const top = w.addStack();
  top.layoutHorizontally();
  top.topAlignContent();
  const left = top.addStack();
  left.layoutVertically();
  const row = left.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  bulb(row, v.power, titleSize - 4, v.tone);
  row.addSpacer(6);
  label(row, v.title, titleSize, v.tone, "bold");
  left.addSpacer(2);
  label(left, v.since, 13, C.muted);
  top.addSpacer(8);
  const right = top.addStack();
  right.layoutVertically();
  trailing(right, corner, 12, C.muted);
  if (v.note) {
    right.addSpacer(5);
    trailing(right, v.note.text, 13, v.note.color, "semibold", 2);
  }
}

function small(w, v) {
  const top = w.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  bulb(top, v.power, 15, v.tone);
  top.addSpacer();
  label(top, v.corner, 11, C.muted);
  w.addSpacer();
  label(w, v.title, 20, v.tone, "bold");
  w.addSpacer(1);
  label(w, v.since, 12, C.muted);
  if (v.note) {
    w.addSpacer(6);
    label(w, v.note.text, 12, v.note.color, "semibold").lineLimit = 2;
  }
  if (v.today) {
    w.addSpacer(8);
    picture(w, strip(v.today, v.actual, v.now, SMALL_STRIP));
  }
}

/** Today so far, by the real outages: «● світло було 16 год. 12 хв.  ● не було 1 год. 31 хв.». */
function totals(stack, day, size) {
  const { onMs, offMs } = day.totals.past;
  if (onMs + offMs <= 0) return false;
  const row = stack.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  label(row, "●", size - 3, C.light);
  row.addSpacer(4);
  label(row, `світло було ${duration(onMs)}`, size, C.text);
  row.addSpacer(size);
  label(row, "●", size - 3, C.off);
  row.addSpacer(4);
  label(row, `не було ${duration(offMs)}`, size, C.text);
  return true;
}

function medium(w, v, site) {
  header(w, v, 22, v.corner);
  w.addSpacer();
  if (v.today) {
    const block = w.addStack();
    block.layoutVertically();
    block.url = `${ORIGIN}/${site}#/schedule`;
    picture(block, strip(v.today, v.actual, v.now, MEDIUM_STRIP));
    hours(block);
    block.addSpacer(5);
    totals(block, v.today, 11);
  }
  if (v.tomorrow) {
    w.addSpacer(4);
    label(w, tomorrowText(v.tomorrow), 11, C.muted);
  }
}

function large(w, v, site) {
  header(w, v, 26, v.name);
  w.addSpacer(16);
  const block = w.addStack();
  block.layoutVertically();
  block.url = `${ORIGIN}/${site}#/schedule`;
  if (v.today) {
    label(block, v.today.label, 12, C.muted, "semibold");
    block.addSpacer(6);
    picture(block, strip(v.today, v.actual, v.now, WIDE_STRIP));
    hours(block);
    block.addSpacer(8);
    totals(block, v.today, 12);
  }
  if (v.tomorrow) {
    block.addSpacer(18);
    label(block, v.tomorrow.label, 12, C.muted, "semibold");
    block.addSpacer(6);
    const planned = v.tomorrow.segments.some((s) => s.kind === "off");
    if (planned) {
      picture(block, strip(v.tomorrow, [], v.now, PLAN_STRIP));
      hours(block);
    } else {
      const box = block.addStack();
      box.backgroundColor = C.well;
      box.cornerRadius = 9;
      box.setPadding(6, 10, 6, 10);
      const text = tomorrowText(v.tomorrow).replace(/^Завтра:? /, "");
      label(centered(box), text.charAt(0).toUpperCase() + text.slice(1), 12, C.muted);
    }
  }
  w.addSpacer();
  label(
    w,
    v.fresh ? `Оновлено о ${hhmm(v.updated)}` : `Немає зв'язку · дані на ${hhmm(v.updated)}`,
    10,
    v.fresh ? C.muted : C.warn,
  );
}

// Lock screen: the system tints these, so only the shape and the words matter.

function rectangular(w, v) {
  const row = w.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  bulb(row, v.power, 13, C.text);
  row.addSpacer(4);
  label(row, v.title, 15, C.text, "bold");
  label(w, v.since, 13, C.text);
  if (v.note) label(w, v.note.text, 13, C.text);
}

function circular(w, v) {
  w.addAccessoryWidgetBackground = true;
  bulb(centered(w), v.power, 18, C.text);
  if (v.next) {
    w.addSpacer(2);
    label(centered(w), hhmm(v.next.at), 12, C.text, "semibold");
  }
}

function inline(w, v) {
  w.addText(`${v.title} · ${v.since}`);
}

/** No data at all: the building is unknown, or there was never a connection. */
function message(w, family, title, text) {
  if (family === "accessoryInline") {
    w.addText(`Світло4U · ${title}`);
    return;
  }
  const lock = family.indexOf("accessory") === 0;
  if (!lock) {
    label(w, "Світло4U", 11, C.muted);
    w.addSpacer();
  }
  label(w, title, lock ? 14 : 16, C.text, "bold").lineLimit = 2;
  w.addSpacer(4);
  label(w, text, 12, C.muted).lineLimit = 3;
  if (!lock) w.addSpacer();
}

function build(result, family, site, now) {
  const w = new ListWidget();
  w.url = `${ORIGIN}/${site}`;
  if (family.indexOf("accessory") !== 0) {
    const gradient = new LinearGradient();
    gradient.colors = [C.bgTop, C.bgBottom];
    gradient.locations = [0, 1];
    w.backgroundGradient = gradient;
    w.setPadding(14, 14, 14, 14);
  }
  if (!result.data) {
    if (result.missing) {
      message(w, family, "Будинок не знайдено", `Перевірте поле Parameter віджета: «${site}».`);
    } else {
      message(w, family, "Немає зв'язку", "Спробуємо ще раз за кілька хвилин.");
    }
    w.refreshAfterDate = new Date(now + (result.missing ? 60 : 5) * MINUTE);
    return w;
  }
  const v = view(result.data, now, result.fresh);
  if (family === "small") small(w, v);
  else if (family === "large" || family === "extraLarge") large(w, v, site);
  else if (family === "accessoryRectangular") rectangular(w, v);
  else if (family === "accessoryCircular") circular(w, v);
  else if (family === "accessoryInline") inline(w, v);
  else medium(w, v, site);
  // the core says when the picture changes next (a planned boundary, at least every 15 min)
  w.refreshAfterDate = new Date(
    result.fresh ? Math.max(now + MINUTE, result.data.refreshAt) : now + 5 * MINUTE,
  );
  return w;
}

const site = siteFromParameter(args.widgetParameter);
const widget = build(await load(site), config.widgetFamily || "medium", site, Date.now());
if (config.runsInWidget || config.runsInAccessoryWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
