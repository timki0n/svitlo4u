import { useEffect, useState } from "react";
import { api, type Me, type MyBuilding, type OwnedChat } from "./api.ts";
import { duration, hhmm } from "./format.ts";
import { forgetRecent, type Live, recentSites, type SiteRef } from "./live.ts";
import { inMiniApp, openTelegramLink } from "./telegram.ts";
import { BackLink, Header, Icon } from "./ui.tsx";

const TZ = "Europe/Kyiv";
/** The hub reports every 30 s: two missed minutes is «мовчить». */
const SILENT_AFTER_MS = 2 * 60_000;
const NAME_MAX = 60;
const RECENT_SHOWN = 4;

/**
 * «Мої будинки» (the button by the building's name, also /my): the building shown now, then the
 * screen's one orange button «Знайти мій будинок» (the shown one is often not mine: a link, the
 * default), the favorites (★, Mini App), the ones this device opened lately. Owners (by a hub, or
 * named in sites.yaml like ЖК 4U) also see their buildings: the hub, the chats.
 */
export function MineScreen({ live, back }: { live: Live; back: string }) {
  const [me, setMe] = useState<Me | null>(live.me);
  const [failed, setFailed] = useState(false);
  const [recent, setRecent] = useState<SiteRef[]>(recentSites);

  useEffect(() => {
    if (!inMiniApp()) return;
    api.me().then(setMe, (e: unknown) => {
      console.error(e);
      setFailed(true);
    });
  }, []);

  const shownId = live.site?.id ?? null;
  const owned = [...(me?.buildings ?? [])].sort(
    (a, b) => Number(b.site.id === shownId) - Number(a.site.id === shownId),
  );
  const ownsShown = owned.some((b) => b.site.id === shownId);
  const favorites = me?.favorites.filter((f) => f.id !== shownId) ?? [];
  const listed = new Set([shownId, ...favorites.map((f) => f.id), ...owned.map((b) => b.site.id)]);
  const recents = recent.filter((r) => !listed.has(r.id)).slice(0, RECENT_SHOWN);

  return (
    <main className="screen">
      <Header>
        <BackLink href={back} />
      </Header>
      <h1 className="title">Мої будинки</h1>
      {failed && (
        <p className="notice" role="alert">
          Не вдалося отримати дані. Закрийте й відкрийте застосунок ще раз.
        </p>
      )}
      {live.site && !ownsShown && <ShownCard live={live} me={me} onChange={setMe} />}
      <a className="button find-building" data-kind="primary" href="#/add">
        <Icon name="search" />
        Знайти мій будинок
      </a>
      {owned.map((building) => (
        <BuildingCard
          key={building.site.id}
          building={building}
          shown={building.site.id === shownId}
          onChange={setMe}
        />
      ))}
      {favorites.length > 0 && (
        <section className="card" aria-label="Обране">
          <span className="small-label">Обране</span>
          {favorites.map((site) => (
            <SiteRow
              key={site.id}
              site={site}
              icon="star"
              removeLabel={`Прибрати «${site.name}» з обраного`}
              onRemove={() => api.removeFavorite(site.id).then(setMe)}
            />
          ))}
        </section>
      )}
      {recents.length > 0 && (
        <section className="card" aria-label="Нещодавні">
          <span className="small-label">Нещодавні</span>
          {recents.map((site) => (
            <SiteRow
              key={site.id}
              site={site}
              icon="clock"
              removeLabel={`Прибрати «${site.name}» з нещодавніх`}
              onRemove={async () => setRecent(forgetRecent(site.id))}
            />
          ))}
        </section>
      )}
    </main>
  );
}

/** The building shown now (not one of mine as an owner): its light; in the Mini App ★. */
function ShownCard({
  live,
  me,
  onChange,
}: {
  live: Live;
  me: Me | null;
  onChange: (me: Me) => void;
}) {
  const site = live.site;
  const state = live.state;
  const [busy, setBusy] = useState(false);
  if (!site) return null;
  const favorite = me?.favorites.some((f) => f.id === site.id) ?? false;

  const toggle = async () => {
    setBusy(true);
    try {
      onChange(await (favorite ? api.removeFavorite(site.id) : api.addFavorite(site.id)));
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Відкрито зараз">
      <span className="small-label">Відкрито зараз</span>
      <span className="card-title">{site.name}</span>
      {state && (
        <div className="hub-state" data-ok={state.power === "on"} data-power={state.power}>
          <span className="dot" aria-hidden="true" />
          {lightText(state.power, state.since)}
        </div>
      )}
      {me && (
        <div className="hub-actions">
          <button
            className="button"
            type="button"
            disabled={busy}
            aria-pressed={favorite}
            onClick={() => void toggle()}
          >
            <Icon name="star" color={favorite ? "var(--light)" : "var(--muted)"} />
            {favorite ? "В обраному" : "В обране"}
          </button>
        </div>
      )}
    </section>
  );
}

/** A building at hand (★ or opened lately): open it — it becomes mine — or drop it from the list. */
function SiteRow({
  site,
  icon,
  removeLabel,
  onRemove,
}: {
  site: SiteRef;
  icon: "star" | "clock";
  removeLabel: string;
  onRemove: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="fav-row">
      <a className="fav-name" href={`/${site.id}`}>
        <Icon name={icon} color={icon === "star" ? "var(--light)" : "var(--muted)"} />
        {site.name}
      </a>
      <button
        className="button"
        data-kind="quiet"
        type="button"
        disabled={busy}
        aria-label={removeLabel}
        onClick={() => {
          setBusy(true);
          onRemove()
            .catch((e: unknown) => console.error(e))
            .finally(() => setBusy(false));
        }}
      >
        Прибрати
      </button>
    </div>
  );
}

function lightText(power: "on" | "off" | "unknown", since: number | null): string {
  const word = power === "on" ? "Світло є" : power === "off" ? "Світла немає" : "Світло невідоме";
  return since !== null && power !== "unknown" ? `${word} · з ${hhmm(since, TZ)}` : word;
}

function BuildingCard({
  building,
  shown,
  onChange,
}: {
  building: MyBuilding;
  shown: boolean;
  onChange: (me: Me) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(building.site.name);
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

  /** Show this building: the Mini App opens on it from now on. */
  const open = () => {
    void api.setMySite(building.site.id).finally(() => {
      location.href = `/${building.site.id}`;
    });
  };

  const { site, hub } = building;
  const status = hub?.status ?? null;
  const seen = status?.lastReportAt ?? null;
  const silent = hub !== null && (seen === null || now - seen > SILENT_AFTER_MS);
  const light =
    building.power === "on"
      ? "світло є"
      : building.power === "off"
        ? "світла немає"
        : "світло невідоме";
  const since = building.since !== null ? ` · з ${hhmm(building.since, TZ)}` : "";

  return (
    <section className="card hub-card">
      <div className="card-head">
        <span className="card-title">{site.name}</span>
        <span className="muted hub-id">{hub ? hub.id : "без хаба"}</span>
      </div>

      <div
        className="hub-state"
        data-ok={!silent && building.power !== "unknown"}
        data-power={silent ? undefined : building.power}
      >
        <span className="dot" aria-hidden="true" />
        {hub && seen === null
          ? "Хаб ще не виходив на зв'язок"
          : silent && seen !== null
            ? `Хаб мовчить ${duration(now - seen)} (з ${hhmm(seen, TZ)})`
            : `${light[0]?.toUpperCase()}${light.slice(1)}${since}`}
      </div>
      {status && (
        <p className="muted hub-facts">
          {[
            status.voltage !== null && status.mains === "on"
              ? `${Math.round(status.voltage)} В`
              : null,
            status.paired === false ? "розетку не під'єднано" : null,
            status.rssi !== null ? `сигнал ${signalWord(status.rssi)} (${status.rssi} dBm)` : null,
            status.fw ? `прошивка ${status.fw}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {status?.alertDelay != null && (
        <p className="muted hub-note">
          Про відключення ви дізнаєтесь приблизно за {status.alertDelay} с: стільки хаб чекає, поки
          розетка мовчить{status.alertDelay > 10 ? ". Що краще сигнал, то швидше" : ""}. Час у
          сповіщенні точний.
        </p>
      )}

      {hub && editing ? (
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
        {shown ? (
          <span className="badge">Відкрито зараз</span>
        ) : (
          <button className="button" type="button" onClick={open}>
            Відкрити
          </button>
        )}
        {hub && site.renamable && !editing && (
          <button className="button" type="button" onClick={() => setEditing(true)}>
            Перейменувати
          </button>
        )}
        {hub &&
          (!confirmRelease ? (
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
                Хаб більше не буде вашим. Хто наступним відсканує QR з наклейки, стане власником
                разом із будинком.
              </p>
              <div className="hub-actions">
                <button
                  className="button"
                  data-kind="danger"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() => api.releaseHub(hub.id), "Не вдалося звільнити хаб.")
                  }
                >
                  Звільнити
                </button>
                <button className="button" type="button" onClick={() => setConfirmRelease(false)}>
                  Скасувати
                </button>
              </div>
            </div>
          ))}
      </div>
      {error && (
        <p className="warn-line" role="alert">
          {error}
        </p>
      )}
      <Chats building={building} onChange={onChange} />
    </section>
  );
}

/** Where the building's notices go besides the owner: groups (or their topics) and channels. */
function Chats({ building, onChange }: { building: MyBuilding; onChange: (me: Me) => void }) {
  const siteId = building.site.id;
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (run: () => Promise<Me>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await run());
      setConfirm(null);
    } catch (e) {
      console.error(e);
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hub-chats">
      <span className="small-label">Чати й канали</span>
      {building.chats.length === 0 && (
        <p className="muted hub-note">
          Поки сповіщення приходять лише вам. Додайте бота в групу будинку або в канал — їх
          отримуватимуть усі там.
        </p>
      )}
      {building.chats.map((chat) => {
        const key = `${chat.chatId}:${chat.threadId}`;
        return (
          <div className="chat-row" key={key}>
            <div className="card-head">
              <span className="chat-title">{chatName(chat)}</span>
              <span className="muted hub-id">{chatKind(chat)}</span>
            </div>
            <p className="muted hub-note">{chatState(chat)}</p>
            {chat.bot === "no-delete" && (
              <p className="warn-line">
                Щоб стрічка працювала, зробіть бота адміністратором групи з правом «Видаляти
                повідомлення».
              </p>
            )}
            {chat.bot === "no-post" && (
              <p className="warn-line">
                Бот не може публікувати: дайте йому в каналі право «Публікувати повідомлення».
              </p>
            )}
            {chat.fixed ? (
              <p className="muted hub-note">Налаштовано на сервері: змінюється там.</p>
            ) : confirm === key ? (
              <div className="hub-confirm">
                <p className="muted">Сповіщення сюди більше не приходитимуть, бот вийде з чату.</p>
                <div className="hub-actions">
                  <button
                    className="button"
                    data-kind="danger"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => api.removeChat(chat.chatId, chat.threadId),
                        "Не вдалося прибрати бота.",
                      )
                    }
                  >
                    Прибрати
                  </button>
                  <button className="button" type="button" onClick={() => setConfirm(null)}>
                    Скасувати
                  </button>
                </div>
              </div>
            ) : (
              <div className="hub-actions">
                {chat.kind === "group" && (
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => api.setChatFeed(chat.chatId, chat.threadId, !chat.feed),
                        "Не вдалося змінити.",
                      )
                    }
                  >
                    {chat.feed ? "Дозволити писати всім" : "Зробити стрічкою"}
                  </button>
                )}
                <button
                  className="button"
                  data-kind="quiet"
                  type="button"
                  onClick={() => setConfirm(key)}
                >
                  Прибрати бота
                </button>
              </div>
            )}
          </div>
        );
      })}
      {error && (
        <p className="warn-line" role="alert">
          {error}
        </p>
      )}
      <div className="hub-actions">
        {building.groupLink && (
          <button
            className="button"
            type="button"
            onClick={() => openTelegramLink(building.groupLink as string)}
          >
            Додати в групу
          </button>
        )}
        {building.channelLink && (
          <button
            className="button"
            type="button"
            onClick={() => {
              // The channel takes the building chosen last: this one.
              void api.setMySite(siteId).then(onChange, () => {});
              openTelegramLink(building.channelLink as string);
            }}
          >
            Додати в канал
          </button>
        )}
      </div>
    </div>
  );
}

/** The plug's signal at the hub in words (the delay before an outage alert follows it). */
function signalWord(rssi: number): string {
  if (rssi >= -60) return "добрий";
  if (rssi >= -75) return "середній";
  return "слабкий";
}

function chatName(chat: OwnedChat): string {
  const name = chat.title ?? (chat.kind === "channel" ? "Канал" : "Група");
  return chat.threadId ? `${name} · тема ${chat.threadId}` : name;
}

function chatKind(chat: OwnedChat): string {
  if (chat.kind === "channel") return "канал";
  return chat.feed ? "стрічка" : "група";
}

function chatState(chat: OwnedChat): string {
  if (chat.kind === "channel") return "Бот публікує сюди сповіщення про світло.";
  return chat.feed
    ? "Стрічка: пишуть лише адміни, решту бот видаляє."
    : "Звичайний чат: сповіщення приходять сюди, писати можуть усі.";
}
