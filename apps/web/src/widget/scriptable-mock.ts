/**
 * A stand-in for the part of Scriptable's API (https://docs.scriptable.app) the widget script
 * uses: enough to run the script in tests and to draw its layout as HTML for a look. Not the real
 * SwiftUI layout — stacks become flexboxes.
 */

export class Color {
  readonly hex: string;
  readonly alpha: number;
  constructor(hex: string, alpha = 1) {
    this.hex = hex;
    this.alpha = alpha;
  }
}

export class Font {
  readonly weight: number;
  readonly size: number;
  readonly rounded: boolean;
  constructor(weight: number, size: number, rounded: boolean) {
    this.weight = weight;
    this.size = size;
    this.rounded = rounded;
  }
  static mediumRoundedSystemFont = (size: number) => new Font(500, size, true);
  static semiboldRoundedSystemFont = (size: number) => new Font(600, size, true);
  static boldRoundedSystemFont = (size: number) => new Font(700, size, true);
  static mediumSystemFont = (size: number) => new Font(500, size, false);
  static semiboldSystemFont = (size: number) => new Font(600, size, false);
  static boldSystemFont = (size: number) => new Font(700, size, false);
}

export class Size {
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

export class Point {
  readonly x: number;
  readonly y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

export class Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  constructor(x: number, y: number, width: number, height: number) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
}

export class LinearGradient {
  colors: Color[] = [];
  locations: number[] = [];
}

/** A drawn image (SVG) or an SF Symbol by name. */
export class Image {
  readonly svg: string | null;
  readonly symbol: string | null;
  constructor(svg: string | null, symbol: string | null) {
    this.svg = svg;
    this.symbol = symbol;
  }
}

export class SFSymbol {
  font: Font | null = null;
  readonly name: string;
  private constructor(name: string) {
    this.name = name;
  }
  static named(name: string): SFSymbol {
    return new SFSymbol(name);
  }
  applyFont(font: Font): void {
    this.font = font;
  }
  get image(): Image {
    return new Image(null, this.name);
  }
}

export class Path {
  readonly d: string[] = [];
  move(p: Point): void {
    this.d.push(`M${n(p.x)} ${n(p.y)}`);
  }
  addLine(p: Point): void {
    this.d.push(`L${n(p.x)} ${n(p.y)}`);
  }
  addRoundedRect(rect: Rect, rx: number, ry: number): void {
    // CoreGraphics asserts on this (CGPathAddRoundedRect), the widget would crash
    if (rx < 0 || ry < 0 || 2 * rx > rect.width + 1e-9 || 2 * ry > rect.height + 1e-9) {
      throw new Error(
        `addRoundedRect: corners ${rx}×${ry} do not fit ${rect.width}×${rect.height}`,
      );
    }
    const { x, y, width: w, height: h } = rect;
    this.d.push(
      `M${n(x + rx)} ${n(y)}H${n(x + w - rx)}A${n(rx)} ${n(ry)} 0 0 1 ${n(x + w)} ${n(y + ry)}` +
        `V${n(y + h - ry)}A${n(rx)} ${n(ry)} 0 0 1 ${n(x + w - rx)} ${n(y + h)}H${n(x + rx)}` +
        `A${n(rx)} ${n(ry)} 0 0 1 ${n(x)} ${n(y + h - ry)}V${n(y + ry)}A${n(rx)} ${n(ry)} 0 0 1 ${n(x + rx)} ${n(y)}Z`,
    );
  }
}

export class DrawContext {
  size = new Size(0, 0);
  opaque = true;
  respectScreenScale = false;
  readonly shapes: {
    d: string;
    fill: Color | null;
    stroke: Color | null;
    width: number;
    text?: string;
  }[] = [];
  readonly texts: string[] = [];
  private current: string[] = [];
  private fill: Color | null = null;
  private stroke: Color | null = null;
  private width = 1;
  private font: Font | null = null;
  private textColor: Color | null = null;
  private textAlign: "left" | "center" | "right" = "left";
  setFont(font: Font): void {
    this.font = font;
  }
  setTextColor(color: Color): void {
    this.textColor = color;
  }
  setTextAlignedLeft(): void {
    this.textAlign = "left";
  }
  setTextAlignedCenter(): void {
    this.textAlign = "center";
  }
  setTextAlignedRight(): void {
    this.textAlign = "right";
  }
  fillRect(rect: Rect): void {
    const { x, y, width: w, height: h } = rect;
    this.shapes.push({
      d: `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`,
      fill: this.fill,
      stroke: null,
      width: 0,
    });
  }
  /** Text from the rect's top, aligned in its width (no wrapping: the widget's labels are short). */
  drawTextInRect(text: string, rect: Rect): void {
    this.texts.push(text);
    const size = this.font?.size ?? 12;
    const x =
      this.textAlign === "left"
        ? rect.x
        : this.textAlign === "right"
          ? rect.x + rect.width
          : rect.x + rect.width / 2;
    const anchor = { left: "start", center: "middle", right: "end" }[this.textAlign];
    this.shapes.push({
      d: "",
      fill: null,
      stroke: null,
      width: 0,
      text: `<text x="${n(x)}" y="${n(rect.y + size * 0.98)}" text-anchor="${anchor}" font-family="Manrope, 'Segoe UI', system-ui, sans-serif" font-size="${size}" font-weight="${this.font?.weight ?? 400}" fill="${css(this.textColor)}">${escapeHtml(text)}</text>`,
    });
  }
  addPath(path: Path): void {
    this.current.push(...path.d);
  }
  setFillColor(color: Color): void {
    this.fill = color;
  }
  setStrokeColor(color: Color): void {
    this.stroke = color;
  }
  setLineWidth(width: number): void {
    this.width = width;
  }
  fillPath(): void {
    this.shapes.push({ d: this.current.join(""), fill: this.fill, stroke: null, width: 0 });
    this.current = [];
  }
  strokePath(): void {
    this.shapes.push({
      d: this.current.join(""),
      fill: null,
      stroke: this.stroke,
      width: this.width,
    });
    this.current = [];
  }
  getImage(): Image {
    const { width, height } = this.size;
    const body = this.shapes
      .map((s) =>
        s.text
          ? s.text
          : s.fill
            ? `<path d="${s.d}" fill="${css(s.fill)}"/>`
            : `<path d="${s.d}" fill="none" stroke="${css(s.stroke)}" stroke-width="${s.width}"/>`,
      )
      .join("");
    return new Image(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
      null,
    );
  }
}

export class WidgetText {
  font: Font | null = null;
  textColor: Color | null = null;
  lineLimit = 0;
  minimumScaleFactor = 1;
  align: "left" | "center" | "right" = "left";
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  leftAlignText(): void {
    this.align = "left";
  }
  centerAlignText(): void {
    this.align = "center";
  }
  rightAlignText(): void {
    this.align = "right";
  }
}

export class WidgetImage {
  imageSize: Size | null = null;
  tintColor: Color | null = null;
  resizable = true;
  image: Image;
  constructor(image: Image) {
    this.image = image;
  }
}

export class WidgetSpacer {
  readonly length: number | null;
  constructor(length: number | null) {
    this.length = length;
  }
}

type Item = WidgetText | WidgetImage | WidgetSpacer | WidgetStack;
type Axis = "horizontal" | "vertical";

abstract class Container {
  readonly children: Item[] = [];
  abstract layout: Axis;
  align: "top" | "center" | "bottom" = "center";
  padding: [number, number, number, number] | null = null;
  url: string | null = null;
  backgroundColor: Color | null = null;
  backgroundGradient: LinearGradient | null = null;
  size: Size | null = null;
  cornerRadius = 0;
  spacing = 0;
  addText(text: string): WidgetText {
    const item = new WidgetText(text);
    this.children.push(item);
    return item;
  }
  addImage(image: Image): WidgetImage {
    const item = new WidgetImage(image);
    this.children.push(item);
    return item;
  }
  addSpacer(length?: number): WidgetSpacer {
    const item = new WidgetSpacer(length ?? null);
    this.children.push(item);
    return item;
  }
  addStack(): WidgetStack {
    const item = new WidgetStack();
    this.children.push(item);
    return item;
  }
  setPadding(top: number, leading: number, bottom: number, trailing: number): void {
    this.padding = [top, leading, bottom, trailing];
  }
}

export class WidgetStack extends Container {
  layout: Axis = "horizontal";
  layoutHorizontally(): void {
    this.layout = "horizontal";
  }
  layoutVertically(): void {
    this.layout = "vertical";
  }
  topAlignContent(): void {
    this.align = "top";
  }
  centerAlignContent(): void {
    this.align = "center";
  }
  bottomAlignContent(): void {
    this.align = "bottom";
  }
}

export class ListWidget extends Container {
  layout: Axis = "vertical";
  refreshAfterDate: Date | null = null;
  addAccessoryWidgetBackground = false;
  presented: string | null = null;
  async presentSmall(): Promise<void> {
    this.presented = "small";
  }
  async presentMedium(): Promise<void> {
    this.presented = "medium";
  }
  async presentLarge(): Promise<void> {
    this.presented = "large";
  }
}

// ── running the script ──────────────────────────────────────────────────────────────────────

export interface Reply {
  status: number;
  /** A string is a body that is not JSON (a proxy's error page). */
  body: unknown;
}

export interface RunOptions {
  /** config.widgetFamily; null: run in the app. */
  family: string | null;
  parameter?: string | null;
  /** The phone's clock. */
  now: number;
  /** The server; an Error is no connection. */
  respond: (url: string) => Reply | Error;
  /** The script's local files (the cache), kept between runs. */
  files?: Map<string, string>;
}

export interface RunResult {
  widget: ListWidget;
  /** Given to Script.setWidget (in a widget) or presented (in the app). */
  shown: boolean;
  urls: string[];
  logs: string[];
}

export async function runScript(source: string, options: RunOptions): Promise<RunResult> {
  const files = options.files ?? new Map<string, string>();
  const urls: string[] = [];
  const logs: string[] = [];
  const created: ListWidget[] = [];
  let set: ListWidget | null = null;
  const { now } = options;

  class Request {
    timeoutInterval = 60;
    response: { statusCode: number } | null = null;
    readonly url: string;
    constructor(url: string) {
      this.url = url;
    }
    async loadJSON(): Promise<unknown> {
      urls.push(this.url);
      const reply = options.respond(this.url);
      if (reply instanceof Error) throw reply;
      this.response = { statusCode: reply.status };
      if (typeof reply.body === "string") throw new Error("The data couldn't be read (not JSON)");
      return structuredClone(reply.body);
    }
  }
  class TrackedWidget extends ListWidget {
    constructor() {
      super();
      created.push(this);
    }
  }
  class PhoneDate extends Date {
    constructor(...args: unknown[]) {
      super(...((args.length > 0 ? args : [now]) as [number]));
    }
    static override now(): number {
      return now;
    }
  }
  const accessory = options.family?.startsWith("accessory") ?? false;
  const globals: Record<string, unknown> = {
    Color,
    Font,
    Size,
    Point,
    Rect,
    LinearGradient,
    SFSymbol,
    Path,
    DrawContext,
    ListWidget: TrackedWidget,
    Request,
    Date: PhoneDate,
    FileManager: {
      local: () => ({
        cacheDirectory: () => "/cache",
        documentsDirectory: () => "/documents",
        joinPath: (a: string, b: string) => `${a}/${b}`,
        fileExists: (path: string) => files.has(path),
        readString: (path: string) => files.get(path) ?? null,
        writeString: (path: string, text: string) => void files.set(path, text),
      }),
    },
    args: { widgetParameter: options.parameter ?? null },
    config: {
      runsInApp: options.family === null,
      runsInWidget: options.family !== null && !accessory,
      runsInAccessoryWidget: accessory,
      widgetFamily: options.family ?? undefined,
    },
    Script: {
      setWidget: (widget: ListWidget) => {
        set = widget;
      },
      complete: () => {},
    },
    console: { log: (message: unknown) => logs.push(String(message)) },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<void>;
  await new AsyncFunction(...Object.keys(globals), source)(...Object.values(globals));
  const widget = set ?? created[created.length - 1];
  if (!widget) throw new Error("the script made no widget");
  return { widget, shown: set !== null || widget.presented !== null, urls, logs };
}

/** Every text of the widget, in order. */
export function texts(item: Container | Item): string[] {
  if (item instanceof WidgetText) return [item.text];
  if (item instanceof Container) return item.children.flatMap(texts);
  return [];
}

/** Every drawn image of the widget (SVG). */
export function drawings(item: Container | Item): string[] {
  if (item instanceof WidgetImage) return item.image.svg ? [item.image.svg] : [];
  if (item instanceof Container) return item.children.flatMap(drawings);
  return [];
}

// ── a look as HTML ──────────────────────────────────────────────────────────────────────────

/** Widget sizes in points on a 6.1″ iPhone (lock screen ones roughly). */
export const FAMILY_SIZES: Record<string, [number, number]> = {
  small: [158, 158],
  medium: [338, 158],
  large: [338, 354],
  accessoryRectangular: [158, 72],
  accessoryCircular: [72, 72],
  accessoryInline: [240, 22],
};

function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function css(color: Color | null): string {
  if (!color) return "transparent";
  const v = Number.parseInt(color.hex.replace("#", ""), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${color.alpha})`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Like SwiftUI: a flexible spacer makes the stacks around it fill the stack's own axis, a resizable
 * image fills the width.
 */
function expands(item: Item, axis: Axis, within: Axis): boolean {
  if (item instanceof WidgetSpacer) return item.length === null && within === axis;
  if (item instanceof WidgetImage) {
    return item.resizable && item.imageSize === null && axis === "horizontal";
  }
  if (item instanceof WidgetStack) return fills(item, axis);
  return false;
}

function fills(stack: Container, axis: Axis): boolean {
  return stack.children.some((child) => expands(child, axis, stack.layout));
}

const SYMBOLS: Record<string, string> = {
  "lightbulb.fill":
    '<path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/><rect x="8.5" y="18.5" width="7" height="3" rx="1.2"/>',
  "lightbulb.slash":
    '<path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2"/>',
  "questionmark.circle":
    '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/><text x="12" y="16.5" font-size="13" text-anchor="middle" font-family="system-ui" font-weight="700">?</text>',
};

function node(item: Item, parent: Axis): string {
  if (item instanceof WidgetSpacer) {
    return item.length === null
      ? '<i style="flex:1 1 0;min-width:0;min-height:0"></i>'
      : `<i style="flex:0 0 ${item.length}px"></i>`;
  }
  if (item instanceof WidgetText) {
    const f = item.font;
    const family = f?.rounded
      ? "'SF Pro Rounded', ui-rounded, 'Segoe UI Variable Display', 'Segoe UI', system-ui"
      : "system-ui";
    const lines =
      item.lineLimit === 1
        ? "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        : item.lineLimit > 1
          ? `display:-webkit-box;-webkit-line-clamp:${item.lineLimit};-webkit-box-orient:vertical;overflow:hidden;`
          : "";
    return `<span data-min-scale="${item.minimumScaleFactor}" style="font:${f?.weight ?? 400} ${f?.size ?? 17}px/1.2 ${family};color:${css(item.textColor ?? new Color("#ffffff"))};text-align:${item.align};${lines}min-width:0;flex-shrink:1">${escapeHtml(item.text)}</span>`;
  }
  if (item instanceof WidgetImage) {
    if (item.image.symbol) {
      const s = item.imageSize?.width ?? 20;
      const color = css(item.tintColor ?? new Color("#ffffff"));
      return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" style="flex:none;color:${color};fill:${color}">${SYMBOLS[item.image.symbol] ?? ""}</svg>`;
    }
    const src = `data:image/svg+xml;utf8,${encodeURIComponent(item.image.svg ?? "")}`;
    const size = item.imageSize
      ? `width:${item.imageSize.width}px;height:${item.imageSize.height}px`
      : "width:100%;height:auto";
    return `<img src="${src}" style="display:block;align-self:stretch;min-width:0;${size}">`;
  }
  return box(item, parent);
}

function box(stack: Container, parent: Axis | null): string {
  const align =
    stack.layout === "horizontal"
      ? { top: "flex-start", center: "center", bottom: "flex-end" }[stack.align]
      : "flex-start";
  const style = [
    "display:flex",
    `flex-direction:${stack.layout === "horizontal" ? "row" : "column"}`,
    `align-items:${align}`,
    "min-width:0",
    "min-height:0",
    stack.spacing ? `gap:${stack.spacing}px` : "",
    stack.padding ? `padding:${stack.padding.map((p) => `${p}px`).join(" ")}` : "",
    stack.backgroundColor ? `background:${css(stack.backgroundColor)}` : "",
    stack.cornerRadius ? `border-radius:${stack.cornerRadius}px` : "",
  ];
  if (parent) {
    if (fills(stack, parent)) style.push("flex:1 1 0");
    if (fills(stack, parent === "horizontal" ? "vertical" : "horizontal")) {
      style.push("align-self:stretch");
    }
  } else if (!fills(stack, "vertical")) {
    style.push("justify-content:center");
  }
  const link = stack.url ? ` data-url="${escapeHtml(stack.url)}"` : "";
  return `<div${link} style="${style.filter(Boolean).join(";")}">${stack.children.map((c) => node(c, stack.layout)).join("")}</div>`;
}

/** One widget as a fixed-size box, the way the home screen (or the lock screen) shows it. */
export function toHtml(widget: ListWidget, family: string): string {
  const [width, height] = FAMILY_SIZES[family] ?? [338, 158];
  const lock = family.startsWith("accessory");
  const gradient = widget.backgroundGradient;
  const background = gradient
    ? `linear-gradient(180deg, ${gradient.colors.map(css).join(", ")})`
    : lock
      ? widget.addAccessoryWidgetBackground
        ? "rgba(255,255,255,0.18)"
        : "transparent"
      : "#000";
  // the widget's own padding is on its root box; this is the system's default one
  const padding = widget.padding ? [0, 0, 0, 0] : lock ? [0, 0, 0, 0] : [16, 16, 16, 16];
  const radius = family === "accessoryCircular" ? "50%" : lock ? "10px" : "22px";
  const inner = box(widget, null);
  return `<div class="widget" data-family="${family}" style="box-sizing:border-box;width:${width}px;height:${height}px;padding:${padding.map((p) => `${p}px`).join(" ")};border-radius:${radius};background:${background};overflow:hidden;display:flex;flex-direction:column;${lock ? "filter:grayscale(1) brightness(1.4);" : ""}">${inner.replace(/^<div /, '<div data-root="" ').replace('style="', 'style="flex:1 1 0;')}</div>`;
}

/** Text that does not fit shrinks down to its minimumScaleFactor, as on the phone. */
export const SHRINK_SCRIPT = `for (const el of document.querySelectorAll("[data-min-scale]")) {
  const min = Number(el.dataset.minScale) || 1, base = parseFloat(getComputedStyle(el).fontSize);
  for (let k = 1; k >= min && (el.scrollWidth > el.clientWidth + 0.5 || el.scrollHeight > el.clientHeight + 0.5); k -= 0.05)
    el.style.fontSize = (base * k).toFixed(2) + "px";
}`;
