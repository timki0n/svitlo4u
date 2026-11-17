import type { ReactNode } from "react";
import type { Site } from "./api.ts";
import { duration, hhmm, percents } from "./format.ts";
import type { Connection } from "./live.ts";
import { inMiniApp } from "./telegram.ts";

export const SUPPORT_URL = "https://send.monobank.ua/jar/A1DjHMA1sm";

const ICONS = {
  now: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />,
  down: <path d="M6 9l6 6 6-6" />,
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
  plus: <path d="M12 5v14M5 12h14" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  bell: <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  star: <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9L12 3z" />,
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
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  edit: <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z" />,
  megaphone: <path d="M3 11l18-5v12L3 14v-3zM11.6 16.8a3 3 0 1 1-5.8-1.6" />,
};

export function Icon({
  name,
  size = 18,
  color = "currentColor",
  fill = "none",
}: {
  name: keyof typeof ICONS;
  size?: number;
  color?: string;
  /** Filled: a ★ that is on. */
  fill?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
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

/** The mark of Світло4U: a roof and a lit window (docs/brand). */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="20 22 80 74" width={size} height={(size * 74) / 80} aria-hidden="true">
      <path
        d="M25 57 L60 28 L95 57"
        fill="none"
        stroke="var(--text)"
        strokeWidth={8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x={43}
        y={58}
        width={34}
        height={34}
        rx={8}
        fill="var(--light)"
        style={{ filter: "drop-shadow(0 0 5px var(--light-glow))" }}
      />
    </svg>
  );
}

/** Longer names than this do not fit beside «Про проєкт» on a 375 px phone. */
const LONG_NAME = 9;

/**
 * The building's name: a button with an arrow that opens «Мої будинки» — my building, the
 * favorites, «Знайти мій будинок»; for owners also their hubs and chats.
 */
export function SiteName({ name }: { name: string }) {
  return (
    <a
      className="site-switch"
      href="#/my"
      aria-label={`${name}: інші будинки`}
      // a long name takes the room of «Про проєкт» on phones (styles.css)
      data-long={name.length > LONG_NAME ? "" : undefined}
    >
      <span className="label">{name}</span>
      <Icon name="down" size={16} color="var(--muted)" />
    </a>
  );
}

/** «Назад» in the header of a sub-screen: «Мої будинки», «Знайти мій будинок», «Про проєкт». */
export function BackLink({ href }: { href: string }) {
  return (
    <a className="site-switch" href={href}>
      <Icon name="back" size={16} color="var(--muted)" />
      <span className="label">Назад</span>
    </a>
  );
}

/** `mark={false}`: a screen of houses already («Мої будинки») does without one more. */
export function Header({ children, mark = true }: { children: ReactNode; mark?: boolean }) {
  return (
    <header className="header">
      <div className="brand-row">
        {mark && (
          <a className="brand" href="/" aria-label="Світло4U — на головну">
            <Mark />
          </a>
        )}
        {children}
      </div>
      {/* «Підтримати» lives on «Про проєкт» now */}
      <a
        className="header-link"
        href="#/about"
        // the label hides on narrow phones: the link keeps its name
        aria-label="Про проєкт і підтримка"
        aria-current={location.hash === "#/about" ? "page" : undefined}
      >
        <Icon name="info" color="var(--light)" />
        <span className="header-link-label">Про проєкт</span>
      </a>
    </header>
  );
}

export type Tab = "now" | "schedule" | "history" | "game" | "my" | "add" | "about";
type NavTab = Exclude<Tab, "my" | "add" | "about">;

export function Nav({ tab, site }: { tab: Tab; site: Site | null }) {
  // The game plays on the windows of ЖК 4U's figure.
  const game = inMiniApp() && site?.scene === "4u";
  // «Мої будинки» and «Знайти мій будинок» open from the building's name, not from here.
  const items: [NavTab, string, string][] = [
    ["now", "#/", "Зараз"],
    ["schedule", "#/schedule", "Графік"],
    ["history", "#/history", "Історія"],
    ...(game ? ([["game", "#/game", "Гра"]] as [NavTab, string, string][]) : []),
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
