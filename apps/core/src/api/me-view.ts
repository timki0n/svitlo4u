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
};

export type OwnedHub = {
  id: string;
  site: { id: string; name: string; access: "public" | "link"; renamable: boolean } | null;
  status: HubStatus;
};

export type MeView = {
  user: { id: number; firstName: string };
  /** My building (the Mini App opens on it); null: none chosen yet. */
  siteId: string | null;
  /** «Мій хаб»: the hubs I own; `groupLink` adds the bot to the building's group chat. */
  hubs: (OwnedHub & { groupLink: string | null })[];
};
