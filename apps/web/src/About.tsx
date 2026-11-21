import type { ReactNode } from "react";
import { BackLink, Header, Icon, Mark, SUPPORT_URL } from "./ui.tsx";

const CODE_URL = "https://github.com/timki0n/svitlo4u";
/** The bot whose Mini App holds the games. */
const BOT = "svitlo_4u_bot";

const ABILITIES: [Parameters<typeof Icon>[0]["name"], string, ReactNode][] = [
  [
    "now",
    "Світло зараз",
    "Є чи немає — і відколи. Про відключення видно менш ніж за пів хвилини, про повернення — одразу.",
  ],
  [
    "schedule",
    "Графік поруч",
    "Вчора, сьогодні й завтра. Коли діють екстрені відключення, так і пишемо: графік не діє.",
  ],
  ["history", "Історія до 90 днів", "Скільки було світла і чи дотримались графіка."],
  ["plug", "Напруга в мережі", "Де стоїть розумна розетка — показуємо вольти."],
  [
    "bell",
    "Сповіщення для будинку",
    "Повідомлення, щойно світло зникає чи повертається, і графік на завтра.",
  ],
  [
    "phone",
    "Віджет на iPhone",
    <>
      Стан світла й графік на головному чи заблокованому екрані. <a href="#/widget">Як поставити</a>
    </>,
  ],
  // the game lives in the bot's Mini App (for buildings with a facade to play on: ЖК 4U for now)
  [
    "game",
    "Ігри в Telegram",
    <>
      Міні-ігри для сусідів: головоломки у вікнах будинку й карткові вечорниці — у застосунку бота{" "}
      <a href={`https://t.me/${BOT}`} target="_blank" rel="noopener">
        @{BOT}
      </a>
      . З ними не засумуєте навіть під час довгих відключень.
    </>,
  ],
];

/** Looks like a link in the chat; the chat is a picture, so it leads nowhere. */
function ChatLink({ children }: { children: ReactNode }) {
  return <span className="chat-link">{children}</span>;
}

/**
 * Messages the bot really sent to ЖК 4U (the exact wording; 16–17.11.2026, the schedule without the
 * night slot that did not happen), as one evening and the next day.
 */
const CHAT: ({ day: string } | { time: string; text: ReactNode })[] = [
  { day: "16 листопада" },
  {
    time: "21:00",
    text: (
      <>
        🔔 З'явився <ChatLink>графік на завтра</ChatLink>!{"\n\n"}📅 Розклад на 17.11.2026{"\n\n"}
        1. 12:00 – 17:00 (5 год.){"\n"}2. 21:00 – 00:00 (3 год.)
      </>
    ),
  },
  { day: "17 листопада" },
  {
    time: "12:11",
    text: (
      <>
        🔔⚠️ Світло ЗНИКЛО.{"\n"}Час зі світлом: 16 год. 56 хв.{"\n"}За <ChatLink>графіком</ChatLink>{" "}
        світло має відновитися о 17:00.
      </>
    ),
  },
  {
    time: "16:18",
    text: "🔔✅ Світло ВІДНОВЛЕНО.\nЧас без світла: 4 год. 6 хв.\nНайближче відключення о 21:00",
  },
  { time: "16:31", text: "⚠️ Низька напруга: 190 В.\nБережіть техніку." },
];

/**
 * «Про проєкт» (#/about, the link at the right of the header): what Світло4U is, what it does, how
 * its messages look in Telegram, how it differs from schedule apps and «is the device online» bots,
 * the way to one's own building, and «Підтримати».
 */
export function AboutScreen({ back }: { back: string }) {
  return (
    <main className="screen">
      <Header>
        <BackLink href={back} />
      </Header>
      <h1 className="title">Про проєкт</h1>

      <section className="card about-hero" aria-label="Світло4U">
        <Mark size={52} />
        <p className="about-name">Світло4U</p>
        <p className="about-lead">Чи є світло у вашому будинку — насправді, а не за графіком.</p>
        <p className="muted about-text">
          Пристрій у будинку помічає, коли світло зникає й повертається. Поруч ми показуємо графік
          відключень — тож видно і план, і факт.
        </p>
      </section>

      <section className="card" aria-labelledby="about-can">
        <h2 className="small-label" id="about-can">
          Що вміє
        </h2>
        <ul className="about-list">
          {ABILITIES.map(([icon, title, text]) => (
            <li key={title}>
              <span className="about-icon">
                <Icon name={icon} color="var(--light)" />
              </span>
              <span>
                <strong>{title}</strong>
                <span className="muted">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="about-chat">
        <h2 className="small-label" id="about-chat">
          Сповіщення в Telegram
        </h2>
        <div className="chat">
          <div className="chat-head" aria-hidden="true">
            <Mark size={30} />
            <span>
              <strong>Світло4U</strong>
              <span className="muted">бот</span>
            </span>
          </div>
          <ol className="chat-log" aria-label="Приклад сповіщень бота">
            {CHAT.map((item) =>
              "day" in item ? (
                <li key={item.day} className="chat-day">
                  {item.day}
                </li>
              ) : (
                <li key={item.time} className="chat-msg">
                  {item.text}
                  <span className="chat-pad" />
                  <time className="chat-time">{item.time}</time>
                </li>
              ),
            )}
          </ol>
        </div>
        <p className="muted about-note">
          Справжні повідомлення для ЖК 4U. Бот:{" "}
          <a href={`https://t.me/${BOT}`} target="_blank" rel="noopener">
            @{BOT}
          </a>
        </p>
      </section>

      <section className="card" aria-labelledby="about-diff">
        <h2 className="small-label" id="about-diff">
          Чим відрізняється
        </h2>
        <dl className="about-compare">
          <div>
            <dt>Застосунки з графіками</dt>{" "}
            <dd>
              показують, коли світло можуть вимкнути. Світло4U показує, чи воно є зараз і як було
              насправді.
            </dd>
          </div>
          <div>
            <dt>Боти, що стежать, чи пристрій у будинку на зв'язку,</dt>{" "}
            <dd>
              бачать «відключення» щоразу, як зникає інтернет. Світло4U слухає саму розетку, а коли
              зв'язку з будинком немає, чесно каже: невідомо.
            </dd>
          </div>
          <div>
            <dt>Сервіси, що знають лише «є» чи «немає»,</dt>{" "}
            <dd>
              не скажуть, яка в мережі напруга. Світло4U показує вольти й позначає, коли напруга
              виходить за норму, — щоб ваша техніка була в безпеці.
            </dd>
          </div>
        </dl>
      </section>

      <a className="button find-building" data-kind="primary" href="#/add">
        <Icon name="search" />
        Знайти мій будинок
      </a>

      <section className="card" aria-labelledby="about-support">
        <h2 className="small-label" id="about-support">
          Підтримати
        </h2>
        <p className="about-text">
          Світло4U безкоштовний, без реклами, з відкритим кодом. Почався у 2025 році з одного
          київського будинку — ЖК 4U — і тепер відкритий для інших. Якщо він вам допомагає,
          підтримайте його розвиток.
        </p>
        <a
          className="button"
          data-kind="primary"
          href={SUPPORT_URL}
          target="_blank"
          rel="noopener"
          aria-label="Підтримати проєкт (банка monobank, відкриється в новій вкладці)"
        >
          <Icon name="heart" />
          Підтримати проєкт
        </a>
        <a className="about-code" href={CODE_URL} target="_blank" rel="noopener">
          Відкритий код на GitHub
        </a>
      </section>
    </main>
  );
}
