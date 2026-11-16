import { useEffect, useState } from "react";
import { api, type Me, type OwnedHub } from "./api.ts";
import { duration, hhmm } from "./format.ts";
import { inMiniApp, openTelegramLink } from "./telegram.ts";
import { Header, Icon } from "./ui.tsx";

const TZ = "Europe/Kyiv";
/** The hub reports every 30 s: two missed minutes is «мовчить». */
const SILENT_AFTER_MS = 2 * 60_000;
const NAME_MAX = 60;

/** «Мій хаб» (/my): the Mini App's screen for the hubs a Telegram user owns. */
export function MyHubScreen() {
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    document.title = "Мій хаб · Світло4U";
    if (!inMiniApp()) return;
    api.me().then(setMe, (e: unknown) => {
      console.error(e);
      setFailed(true);
    });
  }, []);

  const back = (
    <a className="support" href={me?.siteId ? `/${me.siteId}` : "/"} aria-label="До будинку">
      <Icon name="back" />
      Будинок
    </a>
  );

  if (!inMiniApp()) {
    return (
      <main className="screen">
        <Header>
          <span className="label">Мій хаб</span>
        </Header>
        <section className="card empty">
          <div className="empty-icon">
            <Icon name="plug" size={30} color="var(--light)" />
          </div>
          <h2>«Мій хаб» відкривається в Telegram</h2>
          <p>Відскануйте QR-код з наклейки хаба, а потім натисніть «Мій хаб» у чаті з ботом.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="screen">
      <header className="header">
        <span className="label">Мій хаб</span>
        {back}
      </header>
      {failed && (
        <p className="notice" role="alert">
          Не вдалося отримати дані. Закрийте й відкрийте застосунок ще раз.
        </p>
      )}
      {!me && !failed && <p className="muted">Завантаження…</p>}
      {me && me.hubs.length === 0 && (
        <section className="card empty">
          <div className="empty-icon">
            <Icon name="plug" size={30} color="var(--muted)" />
          </div>
          <h2>Хаба ще немає</h2>
          <p>Відскануйте QR-код з наклейки хаба — він стане вашим.</p>
        </section>
      )}
      {me?.hubs.map((hub) => (
        <HubCard key={hub.id} hub={hub} onChange={setMe} />
      ))}
    </main>
  );
}

function HubCard({ hub, onChange }: { hub: OwnedHub; onChange: (me: Me) => void }) {
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(hub.site?.name ?? "");
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  const act = async (run: () => Promise<Me>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await run());
      setEditing(false);
      setConfirmRelease(false);
    } catch (e) {
      console.error(e);
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const { status, site } = hub;
  const seen = status.lastReportAt;
  const silent = seen === null || now - seen > SILENT_AFTER_MS;
  const light =
    status.mains === "on"
      ? "світло є"
      : status.mains === "off"
        ? "світла немає"
        : "світло невідоме";

  return (
    <section className="card hub-card">
      <div className="card-head">
        <span className="card-title">{site?.name ?? "Без будинку"}</span>
        <span className="muted hub-id">{hub.id}</span>
      </div>

      <div className="hub-state" data-ok={!silent}>
        <span className="dot" aria-hidden="true" />
        {seen === null
          ? "Ще не виходив на зв'язок"
          : silent
            ? `Мовчить ${duration(now - seen)} (з ${hhmm(seen, TZ)})`
            : `На зв'язку · ${light}`}
      </div>
      <p className="muted hub-facts">
        {[
          status.voltage !== null && status.mains === "on"
            ? `${Math.round(status.voltage)} В`
            : null,
          status.paired === false ? "розетку не під'єднано" : null,
          status.fw ? `прошивка ${status.fw}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {site && editing ? (
        <form
          className="hub-rename"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.renameHub(hub.id, name), "Не вдалося перейменувати.");
          }}
        >
          <input
            className="field"
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            aria-label="Назва будинку"
            // biome-ignore lint/a11y/noAutofocus: the field the person just asked for
            autoFocus
          />
          <button className="button" type="submit" disabled={busy || !name.trim()}>
            Зберегти
          </button>
        </form>
      ) : null}

      <div className="hub-actions">
        {site && (
          <a className="button" href={`/${site.id}`}>
            Сторінка будинку
          </a>
        )}
        {hub.groupLink && (
          <button
            className="button"
            type="button"
            onClick={() => openTelegramLink(hub.groupLink as string)}
          >
            Додати бота в чат будинку
          </button>
        )}
        {site?.renamable && !editing && (
          <button className="button" type="button" onClick={() => setEditing(true)}>
            Перейменувати
          </button>
        )}
        {!confirmRelease ? (
          <button
            className="button"
            data-kind="quiet"
            type="button"
            onClick={() => setConfirmRelease(true)}
          >
            Звільнити хаб
          </button>
        ) : (
          <div className="hub-confirm">
            <p className="muted">
              Хаб більше не буде вашим. Хто наступним відсканує QR з наклейки, стане власником разом
              із будинком.
            </p>
            <div className="hub-actions">
              <button
                className="button"
                data-kind="danger"
                type="button"
                disabled={busy}
                onClick={() => void act(() => api.releaseHub(hub.id), "Не вдалося звільнити хаб.")}
              >
                Звільнити
              </button>
              <button className="button" type="button" onClick={() => setConfirmRelease(false)}>
                Скасувати
              </button>
            </div>
          </div>
        )}
      </div>
      {error && (
        <p className="warn-line" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
