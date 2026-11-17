/**
 * What the Mini App's personal part answers (api/me.ts). Types only, no imports: the web app
 * imports them as they are.
 */

/** A hub's last report as its owner sees it. */
export type HubStatus = {
  lastReportAt: number | null;
  fw: string | null;
  paired: boolean | null;
  mains: "on" | "off" | "unknown" | null;
  voltage: number | null;
  /** Short silences of the plug since the hub started: gaps of the radio link, not the light. */
  linkGaps: number | null;
  /** How soon an outage is told, s: the hub waits this long a silence (longer for a weak signal). */
  alertDelay: number | null;
  /** The plug's signal at the hub, dBm (averaged). */
  rssi: number | null;
};

/** A group (or one of its topics) or a channel that gets the building's notices. */
export type OwnedChat = {
  chatId: number;
  /** A forum topic, 0 for the whole chat. */
  threadId: number;
  kind: "group" | "channel";
  title: string | null;
  /** A feed: only the chat's admins write there, the bot deletes the rest. */
  feed: boolean;
  /** What is missing for it to work: ok, or the right the bot needs. */
  bot: "ok" | "no-delete" | "no-post";
  /** Set in sites.yaml (the server): shown, not changed here. */
  fixed: boolean;
};

/**
 * A building the person owns: by its hub (claimed with the sticker), or named an owner in
 * sites.yaml (ЖК 4U, which has no hub).
 */
export type OwnedBuilding = {
  site: { id: string; name: string; access: "public" | "link"; renamable: boolean };
  /** The light there now. */
  power: "on" | "off" | "unknown";
  since: number | null;
  /** The person's hub there (its status, release), null for a building without one. */
  hub: { id: string; status: HubStatus } | null;
  chats: OwnedChat[];
};

export type MeView = {
  user: { id: number; firstName: string };
  /** My building (the Mini App opens on it); null: none chosen yet. */
  siteId: string | null;
  /** Buildings kept at hand (★), any of them may be opened. */
  favorites: { id: string; name: string }[];
  /** The developer (the admin chat's user): only they give a public building its address. */
  admin: boolean;
  /**
   * «Мої будинки»: `groupLink` adds the bot to the building's group chat, `channelLink` to a
   * channel (as an admin that posts).
   */
  buildings: (OwnedBuilding & { groupLink: string | null; channelLink: string | null })[];
};
