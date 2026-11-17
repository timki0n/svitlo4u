import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  type AddressItem,
  type AddressLookup,
  type AddressPick,
  ApiError,
  api,
  type Me,
} from "./api.ts";
import { inMiniApp } from "./telegram.ts";
import { BackLink, Header, Icon } from "./ui.tsx";

/** The search waits for a pause in typing. */
const DEBOUNCE_MS = 300;
/** YASNO lists this many houses of a street before a number is typed. */
const FIRST_HOUSES = 20;

/**
 * «Знайти мій будинок» (#/add): any Kyiv address from YASNO's search — the street, the house. Where
 * Світло4U already is, open it (it becomes my building) or keep it in the favorites (★, Mini App);
 * where it is not, leave a request: the first people who want a hub there.
 */
export function AddScreen() {
  const [me, setMe] = useState<Me | null>(null);
  const [streetText, setStreetText] = useState("");
  const [streets, setStreets] = useState<AddressItem[] | null>(null);
  const [street, setStreet] = useState<AddressItem | null>(null);
  const [houseText, setHouseText] = useState("");
  const [houses, setHouses] = useState<AddressItem[] | null>(null);
  const [house, setHouse] = useState<AddressItem | null>(null);
  const [found, setFound] = useState<AddressLookup | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (inMiniApp()) api.me().then(setMe, (e: unknown) => console.error(e));
  }, []);

  // Streets as the person types.
  useEffect(() => {
    const text = streetText.trim();
    if (street || text.length < 2) {
      setStreets(null);
      return;
    }
    return debounced(
      DEBOUNCE_MS,
      (signal) =>
        api.streets(text, signal).then((r) => {
          setStreets(r.streets);
          setFailed(false);
        }),
      setFailed,
    );
  }, [streetText, street]);

  // The street's houses: the first ones at once, then by the number typed.
  useEffect(() => {
    if (!street || house) {
      setHouses(null);
      return;
    }
    return debounced(
      houseText.trim() ? DEBOUNCE_MS : 0,
      (signal) =>
        api.houses(street.id, houseText, signal).then((r) => {
          setHouses(r.houses);
          setFailed(false);
        }),
      setFailed,
    );
  }, [street, houseText, house]);

  // What is at the address.
  useEffect(() => {
    setFound(null);
    if (!street || !house) return;
    return debounced(
      0,
      (signal) => api.lookup(street.id, house.id, signal).then(setFound),
      setFailed,
    );
  }, [street, house]);

  const pick: AddressPick | null =
    street && house
      ? { street: street.id, house: house.id, streetName: street.name, houseName: house.name }
      : null;

  // What a screen reader hears as the results change.
  const status = streets
    ? `Вулиць знайдено: ${streets.length}`
    : houses
      ? `Будинків знайдено: ${houses.length}`
      : "";

  return (
    <main className="screen">
      <Header>
        <BackLink href="#/my" />
      </Header>
      <h1 className="title">Знайти мій будинок</h1>

      <section className="card" aria-label="Адреса">
        {street ? (
          <>
            <span className="small-label">Адреса</span>
            <div className="picked">
              <span>
                {street.name}
                {house ? `, ${house.name}` : ""}
              </span>
              <button
                className="button"
                data-kind="quiet"
                type="button"
                aria-label={house ? "Змінити будинок" : "Змінити вулицю"}
                onClick={() => {
                  if (house) {
                    setHouse(null);
                    setHouseText("");
                  } else setStreet(null);
                }}
              >
                Змінити
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="field-label">
              <span className="small-label">Вулиця в Києві</span>
              <input
                className="field"
                type="search"
                enterKeyHint="search"
                placeholder="Наприклад, Хрещатик"
                value={streetText}
                maxLength={60}
                onChange={(e) => setStreetText(e.target.value)}
                // biome-ignore lint/a11y/noAutofocus: the screen is this one field
                autoFocus
              />
            </label>
            {streets?.length === 0 && (
              <p className="muted hub-note">
                Такої вулиці не знайшли. Спробуйте лише назву, без «вул.».
              </p>
            )}
            {streets && streets.length > 0 && (
              <div className="pick-list">
                {streets.map((s) => (
                  <button className="pick" type="button" key={s.id} onClick={() => setStreet(s)}>
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {street && !house && (
          <>
            <label className="field-label">
              <span className="small-label">Номер будинку</span>
              <input
                className="field"
                type="search"
                enterKeyHint="search"
                placeholder="Наприклад, 12А"
                value={houseText}
                maxLength={20}
                onChange={(e) => setHouseText(e.target.value)}
                // biome-ignore lint/a11y/noAutofocus: the next field of the address
                autoFocus
              />
            </label>
            {houses?.length === 0 && (
              <p className="muted hub-note">
                Такого номера не знайшли. Спробуйте інакше: «12А», «5/7».
              </p>
            )}
            {houses && houses.length >= FIRST_HOUSES && !houseText.trim() && (
              <p className="muted hub-note">Це не всі будинки. Не бачите свій — введіть номер.</p>
            )}
            {houses && houses.length > 0 && (
              <div className="pick-list houses">
                {houses.map((h) => (
                  <button className="pick" type="button" key={h.id} onClick={() => setHouse(h)}>
                    {h.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <p className="sr-only" aria-live="polite">
          {status}
        </p>
        {failed && (
          <p className="warn-line" role="alert">
            Пошук адрес зараз не відповідає. Спробуйте трохи згодом.
          </p>
        )}
      </section>

      {pick && found?.site && (
        <FoundCard site={found.site} group={found.group} me={me} onChange={setMe} />
      )}
      {pick && found && !found.site && (
        <RequestCard
          key={`${pick.street}:${pick.house}`}
          pick={pick}
          group={found.group}
          me={me}
          onAttached={(site) => setFound({ ...found, site })}
        />
      )}
    </main>
  );
}

/** The result arrives where the picked house's button was: focus moves to it. */
function useFocusOnShow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: false });
  }, []);
  return ref;
}

/** Світло4U is at the address: open it (it becomes mine), keep it at hand (★). */
function FoundCard({
  site,
  group,
  me,
  onChange,
}: {
  site: { id: string; name: string };
  group: string | null;
  me: Me | null;
  onChange: (me: Me) => void;
}) {
  const ref = useFocusOnShow<HTMLElement>();
  const [busy, setBusy] = useState(false);
  const favorite = me?.favorites.some((f) => f.id === site.id) ?? false;
  return (
    <section className="card result" ref={ref} tabIndex={-1} aria-label="Тут уже є Світло4U">
      <div className="card-head">
        <span className="small-label">Тут уже є Світло4U</span>
        {group && <span className="muted hub-id">черга {group}</span>}
      </div>
      <span className="card-title">{site.name}</span>
      <div className="hub-actions">
        <a className="button" data-kind="primary" href={`/${site.id}`}>
          Відкрити
        </a>
        {me && (
          <button
            className="button"
            type="button"
            disabled={busy}
            aria-pressed={favorite}
            onClick={() => {
              setBusy(true);
              (favorite ? api.removeFavorite(site.id) : api.addFavorite(site.id))
                .then(onChange, (e: unknown) => console.error(e))
                .finally(() => setBusy(false));
            }}
          >
            <Icon name="star" color={favorite ? "var(--light)" : "var(--muted)"} />
            {favorite ? "В обраному" : "В обране"}
          </button>
        )}
      </div>
    </section>
  );
}

/** No building at the address: a request (and, for the admin, «це адреса такого будинку»). */
function RequestCard({
  pick,
  group,
  me,
  onAttached,
}: {
  pick: AddressPick;
  group: string | null;
  me: Me | null;
  onAttached: (site: { id: string; name: string }) => void;
}) {
  const ref = useFocusOnShow<HTMLElement>();
  const tg = inMiniApp();
  const [canAdmin, setCanAdmin] = useState(false);
  const [sparePhone, setSparePhone] = useState(false);
  const [routerOk, setRouterOk] = useState(false);
  const [wantsVoltage, setWantsVoltage] = useState(false);
  const setupId = useId();
  const [contact, setContact] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | "failed" | "limited">("idle");

  const send = async () => {
    setState("busy");
    try {
      await api.sendRequest(
        pick,
        // the setup questions count only under «можу адмініструвати»
        {
          canAdmin,
          sparePhone: canAdmin && sparePhone,
          routerOk: canAdmin && routerOk,
          wantsVoltage: canAdmin && wantsVoltage,
        },
        tg ? "" : contact,
      );
      setState("sent");
    } catch (e) {
      console.error(e);
      setState(e instanceof ApiError && e.status === 429 ? "limited" : "failed");
    }
  };

  if (state === "sent") {
    return (
      <section className="card empty request-done" role="status">
        <div className="empty-icon">
          <Icon name="heart" size={30} color="var(--light)" />
        </div>
        <h2>Дякуємо, заявку прийнято</h2>
        <p>
          {pick.streetName}, {pick.houseName}.{" "}
          {canAdmin
            ? "Напишемо, щоб разом налаштувати Світло4U у вашому будинку."
            : "Напишемо, щойно зможемо тут запуститися."}
        </p>
      </section>
    );
  }

  return (
    <section className="card result" ref={ref} tabIndex={-1} aria-label="Світло4U тут ще немає">
      <div className="card-head">
        <span className="small-label">Світло4U тут ще немає</span>
        {group && <span className="muted hub-id">черга {group}</span>}
      </div>
      <p className="muted hub-note">Залиште заявку — так ми знатимемо, де нас чекають.</p>
      <form
        className="request-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="check">
          <input
            type="checkbox"
            checked={canAdmin}
            aria-controls={setupId}
            onChange={(e) => setCanAdmin(e.target.checked)}
          />
          <span>Можу адмініструвати Світло4U в будинку</span>
        </label>
        {canAdmin && (
          <div className="setup" id={setupId}>
            <p className="check-about" id={`${setupId}-about`}>
              Світло4U стежить за світлом через пристрій у розетці. Його можемо надати ми, а може
              підійти й ваш власний.
            </p>
            <fieldset className="checks" aria-describedby={`${setupId}-about`}>
              <legend className="small-label">Що у вас є</legend>
              <Check checked={sparePhone} onChange={setSparePhone}>
                Старий смартфон на Android, що може весь час лежати на зарядці
              </Check>
              <Check checked={routerOk} onChange={setRouterOk}>
                Роутер, що працює без світла (ДБЖ або павербанк)
              </Check>
            </fieldset>
            <fieldset className="checks">
              <legend className="sr-only">Напруга</legend>
              <Check checked={wantsVoltage} onChange={setWantsVoltage}>
                Хочу бачити напругу в мережі, у вольтах
              </Check>
            </fieldset>
          </div>
        )}
        {!tg && (
          <label className="field-label">
            <span className="small-label">Як з вами зв'язатися</span>
            <input
              className="field"
              type="text"
              autoComplete="tel"
              placeholder="Телефон або e-mail"
              value={contact}
              maxLength={100}
              onChange={(e) => setContact(e.target.value)}
            />
          </label>
        )}
        <button
          className="button"
          data-kind="primary"
          type="submit"
          disabled={state === "busy" || (!tg && contact.trim().length < 3)}
          aria-describedby={`${setupId}-consent`}
        >
          Залишити заявку
        </button>
        {/* the consent: what is kept and why, said where the data is given */}
        <p className="consent" id={`${setupId}-consent`}>
          Надсилаючи заявку, ви погоджуєтеся, що ми збережемо адресу й{" "}
          {tg ? "ваш профіль у Telegram" : "контакт"}, щоб написати вам щодо Світло4U.
        </p>
        {state === "failed" && (
          <p className="warn-line" role="alert">
            Не вдалося надіслати. Спробуйте ще раз.
          </p>
        )}
        {state === "limited" && (
          <p className="warn-line" role="alert">
            Забагато заявок підряд. Спробуйте за кілька хвилин.
          </p>
        )}
      </form>
      {me?.admin && <AttachAddress pick={pick} onAttached={onAttached} />}
    </section>
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** The admin gives a public building this address: the search finds it here from now on. */
function AttachAddress({
  pick,
  onAttached,
}: {
  pick: AddressPick;
  onAttached: (site: { id: string; name: string }) => void;
}) {
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    api.sites(ctrl.signal).then(
      (r) => setSites(r.sites),
      (e: unknown) => {
        if (!ctrl.signal.aborted) console.error(e);
      },
    );
    return () => ctrl.abort();
  }, []);

  if (sites.length === 0) return null;
  return (
    <div className="hub-chats">
      <span className="small-label">Адмін</span>
      <p className="muted hub-note">
        Це адреса будинку зі Світло4U? Тоді пошук знаходитиме його тут.
      </p>
      <div className="hub-actions">
        {sites.map((site) => (
          <button
            className="button"
            type="button"
            key={site.id}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setFailed(false);
              api
                .attachAddress(site.id, pick)
                .then(
                  () => onAttached({ id: site.id, name: site.name }),
                  (e: unknown) => {
                    console.error(e);
                    setFailed(true);
                  },
                )
                .finally(() => setBusy(false));
            }}
          >
            Це «{site.name}»
          </button>
        ))}
      </div>
      {failed && (
        <p className="warn-line" role="alert">
          Не вдалося зберегти адресу.
        </p>
      )}
    </div>
  );
}

/** Runs `job` after `ms` unless the effect is cleaned up first; returns the cleanup. */
function debounced(
  ms: number,
  job: (signal: AbortSignal) => Promise<unknown>,
  onFailed: (failed: boolean) => void,
): () => void {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => {
    job(ctrl.signal).catch((e: unknown) => {
      if (ctrl.signal.aborted) return;
      console.error(e);
      onFailed(true);
    });
  }, ms);
  return () => {
    window.clearTimeout(timer);
    ctrl.abort();
  };
}
