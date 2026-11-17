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

/**
 * «Про проєкт» (#/about, the link at the right of the header): what Світло4U is, what it does and
 * how it differs from schedule apps and «is the device online» bots, and «Підтримати».
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
