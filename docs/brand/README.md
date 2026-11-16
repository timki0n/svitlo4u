# Світло4U · brand

The mark: a roof and a lit window — light at home. Graphite ground, the light `#ff9a3d`
(`#ffd59a` → `#ff7a14` in the window), the roof `#f2efea`; the name in Unbounded 600,
«Світло» light and «4U» orange.

| File             | Use                                                                       |
| ---------------- | ------------------------------------------------------------------------- |
| `mark.svg`       | the mark on its rounded tile, with the window's glow (large sizes)        |
| `mark-plain.svg` | the mark alone, for dark grounds (the site's header draws it inline)      |
| `mark-mono.svg`  | black, for print: the hub's sticker (`firmware/hub/tools/factory.py`)     |
| `square.svg`     | full-bleed square: the source of the PNG icons and the bot's avatar       |
| `bot-avatar.png` | 640×640 for the bot: @BotFather → `/setuserpic` (Telegram crops a circle) |
| `mark-1024.png`  | the tile as a picture                                                     |

The web app's icons are in `apps/web/public/` (`icon.svg` drawn bolder for 16–32 px; PNGs
192/512 maskable and the 180 px Apple touch icon, rendered from `square.svg`). The hub's setup
page draws the mark inline (`firmware/hub/main/portal.html`).
