import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, type Me, type MyBuilding, type OwnedChat } from "./api.ts";
import { duration, hhmm } from "./format.ts";
import { forgetRecent, type Live, recentSites, type SiteRef } from "./live.ts";
import { inMiniApp, openTelegramLink } from "./telegram.ts";
import { BackLink, Header, Icon } from "./ui.tsx";

const TZ = "Europe/Kyiv";
/** The hub reports every 30 s: two missed minutes is «мовчить». */
const SILENT_AFTER_MS = 2 * 60_000;
/** …so the screen re-reads as often while it is open (it showed «мовчить» from a stale read). */
const REFRESH_MS = 30_000;
const NAME_MAX = 60;
const RECENT_SHOWN = 4;

type Power = "on" | "off" | "unknown";
type Light = { power: Power; since: number | null };

/** #/my/<id>: one of my buildings, its hub and chats; #/my: the list. */
function managedId(): string | null {
  const m = /^#\/my\/([a-z0-9][a-z0-9-]{0,39})$/.exec(location.hash);
  return m ? (m[1] as string) : null;
}

/** `load` now, then every REFRESH_MS while the page is seen, and as soon as it is seen again. */
function whileSeen(load: () => void): () => void {
  load();
  const seen = () => {
    if (document.visibilityState === "visible") load();
  };
  const timer = window.setInterval(seen, REFRESH_MS);
  document.addEventListener("visibilitychange", seen);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", seen);
  };
}

/**
 * «Мої будинки» (the button by the building's name, also /my): a calm list — the building shown
 * now, the screen's one orange button «Знайти мій будинок» (the shown one is often not mine: a
 * link, the default), the buildings I own, the favorites (★, Mini App) and the ones this device
 * opened lately, each with its light. An owned building's hub and chats are a screen of their own
 * (#/my/<id>, the gear): the list stays for switching between buildings.
 */
export function MineScreen({ live, back }: { live: Live; back: string }) {
  const [me, setMe] = useState<Me | null>(live.me);
  const [failed, setFailed] = useState(false);
  const [managing, setManaging] = useState(managedId);
  /** Bumped by every change made here: a re-read sent before it must not undo it. */
  const changes = useRef(0);
  const changed = useCallback((next: Me) => {
    changes.current++;
    setMe(next);
  }, []);

  useEffect(() => {
    const onHash = () => setManaging(managedId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // the first read, then again while the screen is open: the hub's state goes stale fast
  useEffect(() => {
    if (!inMiniApp()) return;
    let stopped = false;
    let got = false;
    const stop = whileSeen(() => {
      const at = changes.current;
      api.me().then(
        (next) => {
          got = true;
          if (stopped || at !== changes.current) return;
          setMe(next);
          setFailed(false);
        },
        (e: unknown) => {
          console.error(e);
          if (!stopped && !got) setFailed(true); // a missed re-read keeps the last one
        },
      );
    });
    return () => {
      stopped = true;
      stop();
    };
  }, []);

  // the core's clock: the hub's report time is the core's (the screen re-renders with the tick)
  const now = Date.now() + live.skew;
  const shownLight: Light | null = live.state
    ? { power: live.state.power, since: live.state.since }
    : null;

  if (managing) {
    const building = me?.buildings.find((b) => b.site.id === managing) ?? null;
    return (
      <BuildingScreen
        key={managing}
        building={building}
        loading={inMiniApp() && !me && !failed}
        light={building?.site.id === live.site?.id ? shownLight : null}
        now={now}
        onChange={changed}
      />
    );
  }
  return (
    <MineList
      live={live}
      me={me}
      failed={failed}
      back={back}
      shownLight={shownLight}
      now={now}
      onChange={changed}
    />
  );
}

function MineList({
  live,
  me,
  failed,
  back,
  shownLight,
  now,
  onChange,
}: {
  live: Live;
  me: Me | null;
  failed: boolean;
  back: string;
  shownLight: Light | null;
  now: number;
  onChange: (me: Me) => void;
}) {
  const [recent, setRecent] = useState<SiteRef[]>(recentSites);
  const site = live.site;
  const owned = me?.buildings ?? [];
  const shownOwned = owned.find((b) => b.site.id === site?.id) ?? null;
  const others = owned.filter((b) => b !== shownOwned);
  const ownedIds = new Set(owned.map((b) => b.site.id));
  const favorites = me?.favorites.filter((f) => f.id !== site?.id && !ownedIds.has(f.id)) ?? [];
  const listed = new Set([site?.id, ...ownedIds, ...favorites.map((f) => f.id)]);
  const recents = recent.filter((r) => !listed.has(r.id)).slice(0, RECENT_SHOWN);
  const lights = useLights([...favorites, ...recents].map((s) => s.id));
  const shownSilence = silence(shownOwned, now);
  const atHand = favorites.length > 0 && recents.length > 0;

  return (
    <main className="screen">
      {/* the houses below are enough: no mark here */}
      <Header mark={false}>
        <BackLink href={back} />
      </Header>
      <h1 className="title">Мої будинки</h1>
      {failed && (
        <p className="notice" role="alert">
          Не вдалося отримати дані. Закрийте й відкрийте застосунок ще раз.
        </p>
      )}

      {site && (
        <section className="mine-group" aria-labelledby="mine-now">
          <h2 className="small-label" id="mine-now">
            Відкрито зараз
          </h2>
          <div className="mine-current">
            <BuildingRow
              href="#/"
              name={site.name}
              light={shownSilence === null ? (shownLight ?? shownOwned) : null}
              trouble={troubleLine(shownSilence, now)}
            >
              {shownOwned ? (
                <ManageLink building={shownOwned} silent={shownSilence !== null} />
              ) : (
                me && <StarToggle siteId={site.id} me={me} onChange={onChange} />
              )}
            </BuildingRow>
          </div>
          {shownSilence !== null && <p className="muted mine-note">{SILENT_NOTE}</p>}
        </section>
      )}

      <a className="button find-building" data-kind="primary" href="#/add">
        <Icon name="search" />
        Знайти мій будинок
      </a>

      {others.length > 0 && (
        <section className="mine-group" aria-labelledby="mine-own">
          <h2 className="small-label" id="mine-own">
            Ви керуєте
          </h2>
          <div className="mine-list">
            {others.map((building) => {
              const quiet = silence(building, now);
              return (
                <BuildingRow
                  key={building.site.id}
                  href={`/${building.site.id}`}
                  name={building.site.name}
                  light={quiet === null ? building : null}
                  trouble={troubleLine(quiet, now)}
                >
                  <ManageLink building={building} silent={quiet !== null} />
                </BuildingRow>
              );
            })}
          </div>
        </section>
      )}

      {(favorites.length > 0 || recents.length > 0) && (
        <section className="mine-group" aria-labelledby="mine-hand">
          <h2 className="small-label" id="mine-hand">
            {atHand ? "Обране й нещодавні" : favorites.length > 0 ? "Обране" : "Нещодавні"}
          </h2>
          <div className="mine-list">
            {favorites.map((fav) => (
              <BuildingRow
                key={fav.id}
                href={`/${fav.id}`}
                name={fav.name}
                light={lights[fav.id] ?? null}
              >
                <RowButton
                  label={`Прибрати «${fav.name}» з обраного`}
                  run={() => api.removeFavorite(fav.id).then(onChange)}
                >
                  <Icon name="star" size={20} color="var(--light)" fill="var(--light)" />
                </RowButton>
              </BuildingRow>
            ))}
            {recents.map((r) => (
              <BuildingRow key={r.id} href={`/${r.id}`} name={r.name} light={lights[r.id] ?? null}>
                <RowButton
                  label={`Прибрати «${r.name}» з нещодавніх`}
                  run={async () => setRecent(forgetRecent(r.id))}
                >
                  <Icon name="close" color="var(--muted)" />
                </RowButton>
              </BuildingRow>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

/** The light at buildings that are not mine (★, opened lately): their public state, kept fresh. */
function useLights(ids: string[]): Record<string, Light> {
  const key = ids.join(",");
  const [lights, setLights] = useState<Record<string, Light>>({});
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    const stop = whileSeen(() => {
      for (const id of key.split(",")) {
        api.state(id, ctrl.signal).then(
          (s) => setLights((was) => ({ ...was, [id]: { power: s.power, since: s.since } })),
          (e: unknown) => {
            if (!ctrl.signal.aborted) console.error(e);
          },
        );
      }
    });
    return () => {
      ctrl.abort();
      stop();
    };
  }, [key]);
  return lights;
}

/** null: the hub is on the line (or there is none); "never": not yet; else since when it is silent. */
type Silence = null | "never" | number;

function silence(building: MyBuilding | null, now: number): Silence {
  const hub = building?.hub;
  if (!hub) return null;
  const seen = hub.status.lastReportAt;
  if (seen === null) return "never";
  return now - seen > SILENT_AFTER_MS ? seen : null;
}

function troubleLine(quiet: Silence, now: number): string | null {
  if (quiet === null) return null;
  if (quiet === "never") return "Хаб ще не виходив на зв'язок";
  return `Хаб мовчить ${duration(now - quiet)} · з ${hhmm(quiet, TZ)}`;
}

const SILENT_NOTE =
  "Немає інтернету або хаб вимкнувся. Світло тут невідоме, доки він не повернеться.";

function lightText({ power, since }: Light): string {
  const word = power === "on" ? "Світло є" : power === "off" ? "Світла немає" : "Світло невідоме";
  return since !== null && power !== "unknown" ? `${word} · з ${hhmm(since, TZ)}` : word;
}

/** The mark's house as a building's state: the window lit, blue without light, empty when unknown. */
function House({ power, size = 24 }: { power: Power; size?: number }) {
  return (
    <svg
      className="house"
      data-power={power}
      viewBox="20 22 80 74"
      width={size}
      height={(size * 74) / 80}
      aria-hidden="true"
    >
      <path d="M25 57 L60 28 L95 57" />
      {power === "unknown" ? (
        <rect x={46} y={61} width={28} height={28} rx={6} />
      ) : (
        <rect x={43} y={58} width={34} height={34} rx={8} />
      )}
    </svg>
  );
}

/** A building in a list: its house, name and light (or the hub's trouble); one small action. */
function BuildingRow({
  href,
  name,
  light,
  trouble = null,
  children,
}: {
  href: string;
  name: string;
  /** null: not known yet, or the hub's trouble says more. */
  light: Light | null;
  trouble?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="mine-row">
      <a className="mine-open" href={href}>
        <span className="mine-tile" aria-hidden="true">
          <House power={light?.power ?? "unknown"} />
        </span>
        <span className="mine-text">
          <span className="mine-name">{name}</span>
          {trouble ? (
            <span className="mine-line" data-warn="">
              {trouble}
            </span>
          ) : (
            light && <span className="mine-line">{lightText(light)}</span>
          )}
        </span>
      </a>
      {children}
    </div>
  );
}

/** The gear: the building's hub and chats; a red dot while its hub is silent. */
function ManageLink({ building, silent }: { building: MyBuilding; silent: boolean }) {
  return (
    <a
      className="mine-action"
      href={`#/my/${building.site.id}`}
      aria-label={`Керувати «${building.site.name}»${silent ? ": хаб мовчить" : ""}`}
    >
      <Icon name="gear" size={20} color="var(--muted)" />
      {silent && <span className="mine-alert" aria-hidden="true" />}
    </a>
  );
}

/** ★ for the building shown now (Mini App): kept at hand in «Обране». */
function StarToggle({
  siteId,
  me,
  onChange,
}: {
  siteId: string;
  me: Me;
  onChange: (me: Me) => void;
}) {
  const [busy, setBusy] = useState(false);
  const favorite = me.favorites.some((f) => f.id === siteId);
  return (
    <button
      className="mine-action"
      type="button"
      aria-label="В обране"
      aria-pressed={favorite}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        (favorite ? api.removeFavorite(siteId) : api.addFavorite(siteId))
          .then(onChange, (e: unknown) => console.error(e))
          .finally(() => setBusy(false));
      }}
    >
      <Icon
        name="star"
        size={20}
        color={favorite ? "var(--light)" : "var(--muted)"}
        fill={favorite ? "var(--light)" : "none"}
      />
    </button>
  );
}

function RowButton({
  label,
  run,
  children,
}: {
  label: string;
  run: () => Promise<unknown>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="mine-action"
      type="button"
      aria-label={label}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        run()
          .catch((e: unknown) => console.error(e))
          .finally(() => setBusy(false));
      }}
    >
      {children}
    </button>
  );
}

/** #/my/<id>: an owned building — its name, the hub's facts, the chats, releasing the hub. */
function BuildingScreen({
  building,
  loading,
  light,
  now,
  onChange,
}: {
  building: MyBuilding | null;
  loading: boolean;
  /** The live light when this building is the one shown (fresher than «me»). */
  light: Light | null;
  now: number;
  onChange: (me: Me) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(building?.site.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const header = (
    <Header mark={false}>
      <BackLink href="#/my" />
    </Header>
  );
  if (!building) {
    return (
      <main className="screen">
        {header}
        <p className="muted">{loading ? "Завантаження…" : "Цього будинку немає серед ваших."}</p>
      </main>
    );
  }

  const act = async (run: () => Promise<Me>, failure: string, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await run());
      setEditing(false);
      after?.();
    } catch (e) {
      console.error(e);
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const { site, hub } = building;
  const quiet = silence(building, now);
  const shown = light ?? building;
  const status = hub?.status ?? null;

  return (
    <main className="screen">
      {header}
      <div className="manage-hero">
        <span className="manage-tile" aria-hidden="true">
          <House power={quiet === null ? shown.power : "unknown"} size={42} />
        </span>
        <div className="manage-head">
          <h1 className="title">{site.name}</h1>
          {quiet === null ? (
            <span className="manage-state">{lightText(shown)}</span>
          ) : (
            <span className="manage-state" data-warn="">
              {troubleLine(quiet, now)}
            </span>
          )}
        </div>
        {hub && site.renamable && (
          <button
            className="mine-action"
            type="button"
            aria-label="Перейменувати"
            aria-expanded={editing}
            onClick={() => {
              setName(site.name);
              setEditing(!editing);
            }}
          >
            <Icon name="edit" size={20} color="var(--muted)" />
          </button>
        )}
      </div>
      {hub && editing && (
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
      )}

      {hub && status && (
        <section className="mine-group" aria-labelledby="manage-hub">
          <h2 className="small-label" id="manage-hub">
            Хаб
          </h2>
          <dl className="mine-list mine-facts">
            <Fact name="Зв'язок">
              {quiet === null ? (
                <>
                  <span className="dot" data-ok="" aria-hidden="true" />
                  На зв'язку
                </>
              ) : (
                <span className="warn-text">
                  {quiet === "never"
                    ? "Ще не виходив"
                    : `Мовчить ${duration(now - quiet)} · з ${hhmm(quiet, TZ)}`}
                </span>
              )}
            </Fact>
            {status.paired === false && (
              <Fact name="Розетка">
                <span className="warn-text">Не під'єднана</span>
              </Fact>
            )}
            {status.voltage !== null && status.mains === "on" && (
              <Fact name="Напруга">{Math.round(status.voltage)} В</Fact>
            )}
            {status.wifiRssi !== null && (
              <Fact name="Wi-Fi">
                {status.wifiRssi < WIFI_WEAK ? (
                  <span className="warn-text">{dbm("Слабкий", status.wifiRssi)}</span>
                ) : (
                  dbm(status.wifiRssi >= WIFI_GOOD ? "Гарний" : "Середній", status.wifiRssi)
                )}
              </Fact>
            )}
            {status.rssi !== null && (
              <Fact name="Сигнал розетки">{dbm(signalWord(status.rssi), status.rssi)}</Fact>
            )}
            {status.alertDelay !== null && <Fact name="Сповіщає за">~{status.alertDelay} с</Fact>}
            <Fact name="Прошивка">{[status.fw, hub.id].filter(Boolean).join(" · ")}</Fact>
          </dl>
          {quiet !== null ? (
            <p className="muted mine-note">{SILENT_NOTE}</p>
          ) : status.wifiRssi !== null && status.wifiRssi < WIFI_WEAK ? (
            <p className="muted mine-note">
              Wi-Fi біля хаба слабкий: він може зникати зі зв'язку. Поставте хаб ближче до роутера.
            </p>
          ) : (
            status.rssi !== null && (
              <p className="muted mine-note">Що кращий сигнал розетки, то швидше сповіщення.</p>
            )
          )}
        </section>
      )}

      <Chats building={building} onChange={onChange} />

      {hub && (
        <Release
          busy={busy}
          onRelease={() =>
            void act(
              () => api.releaseHub(hub.id),
              "Не вдалося звільнити хаб.",
              // the building is no longer mine: back to the list
              () => location.replace("#/my"),
            )
          }
        />
      )}
      {error && (
        <p className="warn-line" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="mine-fact">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** «Звільнити хаб»: alone at the bottom, red, asks once more. */
function Release({ busy, onRelease }: { busy: boolean; onRelease: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="mine-list">
      {!asking ? (
        <button className="mine-danger" type="button" onClick={() => setAsking(true)}>
          Звільнити хаб
        </button>
      ) : (
        <div className="hub-confirm mine-more">
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
              onClick={onRelease}
            >
              Звільнити
            </button>
            <button className="button" type="button" onClick={() => setAsking(false)}>
              Скасувати
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Where the building's notices go besides the owner: groups (or their topics) and channels. */
function Chats({ building, onChange }: { building: MyBuilding; onChange: (me: Me) => void }) {
  const siteId = building.site.id;
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { chats, groupLink, channelLink } = building;
  if (chats.length === 0 && !groupLink && !channelLink) return null;

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
    <section className="mine-group" aria-labelledby="manage-chats">
      <h2 className="small-label" id="manage-chats">
        Чати й канали
      </h2>
      <div className="mine-list" data-indent="chat">
        {chats.map((chat) => {
          const key = `${chat.chatId}:${chat.threadId}`;
          const expanded = open === key;
          const more = `chat${chat.chatId}_${chat.threadId}`;
          return (
            <div className="mine-item" key={key}>
              <button
                className="mine-open mine-row"
                type="button"
                aria-expanded={expanded}
                aria-controls={expanded ? more : undefined}
                onClick={() => {
                  setOpen(expanded ? null : key);
                  setConfirm(null);
                }}
              >
                <span className="mine-tile" data-size="sm" aria-hidden="true">
                  <Icon
                    name={chat.kind === "channel" ? "megaphone" : "chat"}
                    color="var(--muted)"
                  />
                </span>
                <span className="mine-text">
                  <span className="mine-name">{chatName(chat)}</span>
                  {chat.bot === "ok" ? (
                    <span className="mine-line">{chatLine(chat)}</span>
                  ) : (
                    <span className="mine-line" data-warn="">
                      Бракує прав у бота
                    </span>
                  )}
                </span>
                <span className="mine-chevron" aria-hidden="true">
                  <Icon name="chevron" color="var(--muted)" />
                </span>
              </button>
              {expanded && (
                <div className="mine-more" id={more}>
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
                      <p className="muted">
                        Сповіщення сюди більше не приходитимуть, бот вийде з чату.
                      </p>
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
              )}
            </div>
          );
        })}
        {groupLink && (
          <button
            className="mine-add mine-row"
            type="button"
            onClick={() => openTelegramLink(groupLink)}
          >
            <span className="mine-tile" data-size="sm" data-flat="" aria-hidden="true">
              <Icon name="plus" color="var(--light)" />
            </span>
            Додати в групу
          </button>
        )}
        {channelLink && (
          <button
            className="mine-add mine-row"
            type="button"
            onClick={() => {
              // The channel takes the building chosen last: this one.
              void api.setMySite(siteId).then(onChange, () => {});
              openTelegramLink(channelLink);
            }}
          >
            <span className="mine-tile" data-size="sm" data-flat="" aria-hidden="true">
              <Icon name="plus" color="var(--light)" />
            </span>
            Додати в канал
          </button>
        )}
      </div>
      {chats.length === 0 && (
        <p className="muted mine-note">
          Поки сповіщення приходять лише вам. Додайте бота в групу будинку або в канал — їх
          отримуватимуть усі там.
        </p>
      )}
      {error && (
        <p className="warn-line" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** The router's signal at the hub, dBm: below this the hub drops off Wi-Fi now and then. */
const WIFI_WEAK = -75;
const WIFI_GOOD = -65;

/** «Середній · −63 dBm». */
function dbm(word: string, value: number): string {
  return `${word} · ${String(Math.round(value)).replace("-", "−")} dBm`;
}

/** The plug's signal at the hub in words (the delay before an outage alert follows it). */
function signalWord(rssi: number): string {
  if (rssi >= -60) return "Гарний";
  if (rssi >= -75) return "Середній";
  return "Слабкий";
}

function chatName(chat: OwnedChat): string {
  const name = chat.title ?? (chat.kind === "channel" ? "Канал" : "Група");
  return chat.threadId ? `${name} · тема ${chat.threadId}` : name;
}

function chatLine(chat: OwnedChat): string {
  if (chat.kind === "channel") return "Канал · бот публікує сповіщення";
  return chat.feed ? "Стрічка · пишуть лише адміни" : "Група · пишуть усі";
}
