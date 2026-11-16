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
  /** Silences of the plug that were the radio, not the mains, since the hub started. */
  linkGaps: number | null;
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
};

export type OwnedHub = {
  id: string;
  site: { id: string; name: string; access: "public" | "link"; renamable: boolean } | null;
  status: HubStatus;
  chats: OwnedChat[];
};

export type MeView = {
  user: { id: number; firstName: string };
  /** My building (the Mini App opens on it); null: none chosen yet. */
  siteId: string | null;
  /**
   * «Мій хаб»: the hubs I own; `groupLink` adds the bot to the building's group chat,
   * `channelLink` to a channel (as an admin that posts).
   */
  hubs: (OwnedHub & { groupLink: string | null; channelLink: string | null })[];
};
