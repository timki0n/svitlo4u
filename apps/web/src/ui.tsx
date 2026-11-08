import type { ReactNode } from "react";
import { duration, hhmm, percents } from "./format.ts";
import type { Connection } from "./live.ts";
import { inMiniApp } from "./telegram.ts";

export const SUPPORT_URL = "https://send.monobank.ua/jar/A1DjHMA1sm";

const ICONS = {
  now: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />,
  schedule: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </>
  ),
  history: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  game: (
    <>
      <rect x="4" y="2.5" width="16" height="19" rx="2" />
      <path d="M8 6.5h2.5M13.5 6.5H16M8 10.5h2.5M13.5 10.5H16M8 14.5h2.5M10.5 21.5v-3h3v3" />
    </>
  ),
  back: <path d="M15 18l-6-6 6-6" />,
  trophy: (
    <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4" />
  ),
  heart: (
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" />
  ),
  warn: (
    <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  ),
  plug: <path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8zM12 18v4" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M8 3v4M16 3v4M3 10h18M12 14v3l2 1" />
    </>
  ),
  rows: <path d="M3 6h18M3 12h18M3 18h18" />,
  refresh: <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />,
  offline: (
    <path d="M2 2l20 20M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.3-1.6M12 20h.01" />
  ),
};

export function Icon({
  name,
  size = 18,
  color = "currentColor",
}: {
  name: keyof typeof ICONS;
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

export function Header({ children }: { children: ReactNode }) {
  return (
    <header className="header">
      {children}
      <a
        className="support"
        href={SUPPORT_URL}
        target="_blank"
        rel="noopener"
        aria-label="Підтримати розробника (банка monobank, відкриється в новій вкладці)"
      >
        <Icon name="heart" color="var(--light)" />
        Підтримати
      </a>
    </header>
  );
}

export type Tab = "now" | "schedule" | "history" | "game";

export function Nav({ tab }: { tab: Tab }) {
  const items: [Tab, string, string][] = [
    ["now", "#/", "Зараз"],
    ["schedule", "#/schedule", "Графік"],
    ["history", "#/history", "Історія"],
    ...(inMiniApp() ? ([["game", "#/game", "Гра"]] as [Tab, string, string][]) : []),
  ];
  return (
    <nav className="nav" aria-label="Розділи">
      {items.map(([key, href, name]) => (
        <a key={key} href={href} aria-current={tab === key ? "page" : undefined}>
          <Icon name={key} size={22} />
          {name}
        </a>
      ))}
    </nav>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="segmented">
      <legend className="sr-only">{label}</legend>
      {options.map(([key, text]) => (
        <button key={key} type="button" aria-pressed={key === value} onClick={() => onChange(key)}>
          {text}
        </button>
      ))}
    </fieldset>
  );
}

export function Swatch({ kind }: { kind: string }) {
  return <span className="swatch" data-kind={kind} aria-hidden="true" />;
}

export function LegendItem({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <span className="legend-item">
      <Swatch kind={kind} />
      {children}
    </span>
  );
}

/** «Світло 14 год 50 хв · 62%» / «Без світла 9 год 10 хв · 38%». */
export function Split({
  onMs,
  offMs,
  onKind = "on",
  offKind = "off",
  onLabel = "Світло",
  offLabel = "Без світла",
}: {
  onMs: number;
  offMs: number;
  onKind?: string;
  offKind?: string;
  onLabel?: string;
  offLabel?: string;
}) {
  const [pOn, pOff] = percents(onMs, offMs);
  return (
    <div className="split">
      <div>
        <span className="split-label">
          <Swatch kind={onKind} />
          {onLabel}
        </span>
        <span className="split-value">
          {duration(onMs)} · <span className="glow">{pOn}%</span>
        </span>
      </div>
      <div>
        <span className="split-label">
          <Swatch kind={offKind} />
          {offLabel}
        </span>
        <span className="split-value">
          {duration(offMs)} · <span className="cool">{pOff}%</span>
        </span>
      </div>
    </div>
  );
}

export function ConnectionNotice({
  connection,
  updatedAt,
  tz,
}: {
  connection: Connection;
  updatedAt: number | null;
  tz: string;
}) {
  if (connection === "live") return null;
  if (connection === "reconnecting")
    return (
      <p className="notice" role="status">
        <Icon name="refresh" size={16} />
        Перепідключення…
      </p>
    );
  return (
    <p className="notice" role="status">
      <Icon name="offline" size={16} />
      Немає зв'язку{updatedAt ? ` · дані на ${hhmm(updatedAt, tz)}` : ""}
    </p>
  );
}
