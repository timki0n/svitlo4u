import { useMemo, useState } from "react";
import { type Live, recentSites, type SiteRef } from "./live.ts";
import { BackLink, Header, Icon } from "./ui.tsx";
import { scriptFor } from "./widget/install.ts";
import source from "./widget/scriptable.js?raw";

const SCRIPTABLE_URL = "https://apps.apple.com/app/scriptable/id1405459188";
/** Buildings offered for the widget's Parameter. */
const LINKS_MAX = 8;

/**
 * Buildings one may want a widget for: the one open now, mine and the favorites (Mini App), the
 * ones this browser opened lately.
 */
function pickable(live: Live): SiteRef[] {
  const out = new Map<string, SiteRef>();
  const add = (ref: SiteRef) => {
    if (!out.has(ref.id)) out.set(ref.id, ref);
  };
  if (live.site) add({ id: live.site.id, name: live.site.name });
  for (const b of live.me?.buildings ?? []) add({ id: b.site.id, name: b.site.name });
  for (const f of live.me?.favorites ?? []) add({ id: f.id, name: f.name });
  for (const r of recentSites()) add(r);
  return [...out.values()].slice(0, LINKS_MAX);
}

/**
 * «Віджет на iPhone» (#/widget, from «Про проєкт»): the Scriptable script set to this building,
 * copied in one tap, and how to put it on the home screen or the lock screen. Loads only when
 * opened (the script is its text).
 */
export default function WidgetScreen({ live, back }: { live: Live; back: string }) {
  const { site } = live;
  const script = useMemo(() => (site ? scriptFor(source, site.id, location.origin) : null), [site]);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const buildings = useMemo(() => pickable(live), [live]);
  /** The building whose link was copied last. */
  const [linkCopied, setLinkCopied] = useState<string | null>(null);

  const copy = () => {
    if (!script) return;
    // straight from the tap: Safari lets the clipboard be written only then
    navigator.clipboard.writeText(script).then(
      () => setCopied("yes"),
      () => setCopied("failed"),
    );
  };

  return (
    <main className="screen">
      <Header>
        <BackLink href={back} />
      </Header>
      <h1 className="title">Віджет на iPhone</h1>

      <section className="card">
        <p className="about-text">
          Чи є світло, коли наступна зміна і графік на сьогодні — на головному екрані чи на
          заблокованому. Працює через безкоштовний застосунок Scriptable.
        </p>
      </section>

      <section className="card" aria-labelledby="widget-how">
        <h2 className="small-label" id="widget-how">
          Як поставити
        </h2>
        <ol className="about-list">
          <li>
            <span className="about-icon step-number">1</span>
            <span>
              <strong>Встановіть Scriptable</strong>
              <span className="muted">Безкоштовно, з App Store.</span>
              <a
                className="button step-action"
                href={SCRIPTABLE_URL}
                target="_blank"
                rel="noopener"
              >
                Відкрити App Store
              </a>
            </span>
          </li>
          <li>
            <span className="about-icon step-number">2</span>
            <span>
              <strong>Скопіюйте скрипт</strong>
              <span className="muted">
                Він уже налаштований на {site ? `«${site.name}»` : "ваш будинок"}.
              </span>
              <button
                type="button"
                className="button step-action"
                data-kind="primary"
                onClick={copy}
                disabled={!script}
              >
                <Icon name={copied === "yes" ? "check" : "copy"} />
                {copied === "yes" ? "Скопійовано" : "Скопіювати скрипт"}
              </button>
              {copied === "failed" && script && (
                <span className="script-fallback">
                  <span className="muted">
                    Не вдалося скопіювати. Виділіть увесь текст нижче й скопіюйте його самі.
                  </span>
                  <textarea
                    className="script-text"
                    readOnly
                    value={script}
                    rows={8}
                    aria-label="Текст скрипта"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </span>
              )}
            </span>
          </li>
          <li>
            <span className="about-icon step-number">3</span>
            <span>
              <strong>Вставте його в Scriptable</strong>
              <span className="muted">
                Натисніть «+» угорі праворуч, вставте текст і натисніть Done. Назву вгорі можна
                змінити, наприклад на «Світло4U».
              </span>
            </span>
          </li>
          <li>
            <span className="about-icon step-number">4</span>
            <span>
              <strong>Додайте віджет</strong>
              <span className="muted">
                Утримуйте палець на порожньому місці головного екрана → «Редагувати» → «Додати
                віджет» → Scriptable і виберіть розмір. Потім утримуйте палець на віджеті →
                «Редагувати віджет» → у полі Script виберіть скрипт.
              </span>
            </span>
          </li>
          {buildings.length > 0 && (
            <li>
              <span className="about-icon step-number">5</span>
              <span className="step-body">
                <strong>Інший будинок</strong>
                <span className="muted">
                  Щоб віджет показував інший будинок, скопіюйте його посилання. Потім утримуйте
                  палець на віджеті → «Редагувати віджет» і вставте посилання в поле Parameter. Так
                  можна поставити кілька віджетів для різних будинків.
                </span>
                <span className="widget-links">
                  {buildings.map((b) => {
                    const link = `${location.origin}/${b.id}`;
                    const done = linkCopied === b.id;
                    return (
                      <span key={b.id} className="widget-link">
                        <span className="mine-text">
                          <span className="mine-name">{b.name}</span>
                          <span className="widget-link-url">{`${location.host}/${b.id}`}</span>
                        </span>
                        <button
                          type="button"
                          className="mine-action"
                          aria-label={done ? "Скопійовано" : `Скопіювати посилання на «${b.name}»`}
                          onClick={() =>
                            navigator.clipboard.writeText(link).then(
                              () => setLinkCopied(b.id),
                              (e: unknown) => console.error(e),
                            )
                          }
                        >
                          <Icon
                            name={done ? "check" : "copy"}
                            color={done ? "var(--light)" : "var(--muted)"}
                          />
                        </button>
                      </span>
                    );
                  })}
                </span>
                {buildings.length === 1 && (
                  <span className="muted step-hint">
                    Інші будинки з'являться тут, щойно ви відкриєте їх на сайті.
                  </span>
                )}
              </span>
            </li>
          )}
        </ol>
      </section>

      <section className="card" aria-labelledby="widget-know">
        <h2 className="small-label" id="widget-know">
          Варто знати
        </h2>
        <dl className="about-compare">
          <div>
            <dt>Оновлення.</dt>{" "}
            <dd>
              Коли оновити віджет, вирішує iOS — зазвичай раз на кілька хвилин. Натисніть на віджет,
              і відкриється сайт зі станом наживо.
            </dd>
          </div>
          <div>
            <dt>Заблокований екран.</dt>{" "}
            <dd>
              Утримуйте палець на заблокованому екрані → «Налаштувати» → віджети → Scriptable.
            </dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
