/** Line icons of the window games (24 × 24, stroked with currentColor). */
const PATHS = {
  cat: '<path d="M5 20c-1-1-1.5-2.5-1.5-4.5V5l4 3.5h9l4-3.5v10.5c0 2-.5 3.5-1.5 4.5-1.6 1.3-4 2-7 2s-5.4-.7-7-2z"/><path d="M9.5 14h.01M14.5 14h.01M11 17.5h2"/>',
  // a head like a bell, wide at the bottom, floppy ears hanging off its sides, dots for eyes and a
  // rounded triangle of a nose
  dog: '<path d="M12 3.4c3 0 4.6 1.4 5.4 3.8l2.4 8.4c.8 3-.8 5.2-3.8 5.2H8c-3 0-4.6-2.2-3.8-5.2l2.4-8.4C7.4 4.8 9 3.4 12 3.4z"/><path d="M8.4 4.5C6.4 4.2 4.2 4.7 3 5.9 1.6 7.3 1.4 10.2 2 12.2c.3 1 1.3 1.3 2.1.7l1.3-1.1M15.6 4.5c2-.3 4.2.2 5.4 1.4 1.4 1.4 1.6 4.3 1 6.3-.3 1-1.3 1.3-2.1.7l-1.3-1.1"/><g fill="currentColor" stroke="none"><circle cx="9.1" cy="11" r=".95"/><circle cx="14.9" cy="11" r=".95"/></g><path d="M9.9 14.8h4.2c.7 0 1 .8.6 1.3L13 18c-.5.5-1.3.5-1.8 0l-1.7-1.9c-.4-.5-.1-1.3.6-1.3z"/>',
  man: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c0-4.1 3.4-7 7.5-7s7.5 2.9 7.5 7"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  lamp: '<path d="M9 18h6M10 21.5h4M12 2.5a6.5 6.5 0 0 0-3.9 11.7c.6.5.9 1.1.9 1.8v.5h6V16c0-.7.3-1.3.9-1.8A6.5 6.5 0 0 0 12 2.5z"/>',
  router:
    '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M10 16.5h.01M8 13 6 6M16 13l2-7"/>',
  laptop: '<rect x="4.5" y="4.5" width="15" height="10.5" rx="1.5"/><path d="M2.5 19.5h19"/>',
  speaker:
    '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><circle cx="12" cy="14.5" r="3.5"/><path d="M12 7h.01"/>',
  headphones:
    '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.5"/>',
  tablet: '<rect x="4" y="2.5" width="16" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  camera:
    '<path d="M4 7.5h3.5L9 5h6l1.5 2.5H20a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5z"/><circle cx="12" cy="13" r="3.5"/>',
  bank: '<rect x="6" y="3" width="12" height="18" rx="2.5"/><path d="M12 7v3l-2 3h4l-2 3"/>',
  docs: '<path d="M7 2.5h7l4.5 4.5v13a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V4A1.5 1.5 0 0 1 7 2.5z"/><path d="M14 2.5V7h4.5M9 12h6M9 16h6"/>',
  candle:
    '<path d="M9 10h6v10.5a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z"/><path d="M12 10V8M12 2.5c1.5 1.6 2 2.7 2 3.5a2 2 0 0 1-4 0c0-.8.5-1.9 2-3.5z"/>',
  torch:
    '<path d="M2.5 9.5h9l3-2.5h5a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-5l-3-2.5h-9z"/><path d="M6.5 12h2"/>',
  aid: '<rect x="3" y="6.5" width="18" height="14" rx="2"/><path d="M9 6.5v-2h6v2M12 10.5v6M9 13.5h6"/>',
  water:
    '<path d="M10 2.5h4v3l2 3v11a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-11l2-3z"/><path d="M8 12.5h8"/>',
  radio:
    '<rect x="3" y="8.5" width="18" height="12" rx="2"/><path d="M7 8.5 17 3.5M16 14.5h.01"/><circle cx="9" cy="14.5" r="2.5"/>',
  food: '<ellipse cx="12" cy="6" rx="6.5" ry="2.5"/><path d="M5.5 6v12c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V6M5.5 11.5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5"/>',
  blanket: '<rect x="3" y="8" width="18" height="10" rx="5"/><path d="M8 8v10M16 8v10"/>',
  clothes:
    '<path d="M8.5 3 4 5.5 2.5 10l3 1.5V21h13v-9.5l3-1.5L20 5.5 15.5 3c-.5 1.6-1.9 2.5-3.5 2.5S9 4.6 8.5 3z"/>',
  sleep:
    '<rect x="5" y="2.5" width="14" height="19" rx="5"/><path d="M5 10h14"/><circle cx="12" cy="6.3" r="1.6"/>',
  cash: '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5h.01M18 14.5h.01"/>',
  thermos: '<rect x="7" y="6" width="10" height="15.5" rx="2.5"/><path d="M9 2.5h6V6H9zM7 11h10"/>',
  book: '<path d="M4 4.5h5.5a2.5 2.5 0 0 1 2.5 2.5v14a2 2 0 0 0-2-2H4zM20 4.5h-5.5A2.5 2.5 0 0 0 12 7v14a2 2 0 0 1 2-2h6z"/>',
  plug: '<path d="M9 2.5v5M15 2.5v5M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0zM12 16v5.5"/>',
  // «Комора»: the power, from a battery up to a generator (the power bank is «bank»)
  cell: '<rect x="7.5" y="5" width="9" height="16.5" rx="2"/><path d="M10.5 5V2.8h3V5M12 10.2v4.6M9.7 12.5h4.6"/>',
  accu: '<rect x="2.5" y="7.5" width="19" height="13" rx="2"/><path d="M5.5 7.5V5h3.5v2.5M15 7.5V5h3.5v2.5M5.8 14h3.4M14.8 14h3.4M16.5 12.3v3.4"/>',
  station:
    '<rect x="3" y="7" width="18" height="14" rx="2.5"/><path d="M8 7V3.5h8V7"/><rect x="6" y="10.5" width="6.5" height="4.5" rx="1"/><path d="M16 11.5h2M16 14.5h2M7 18h.01M10 18h.01"/>',
  generator:
    '<rect x="3.5" y="8.5" width="17" height="11" rx="2"/><path d="M6.5 8.5V5.5h6v3M6 22v-2.5M18 22v-2.5M13.2 11l-2.6 3.5h3l-2.6 3.5"/>',
  // the light, from a match up to a garland (the candle, torch and lamp are above)
  // a match burning: the stick, its head, a flame well above it
  match:
    '<path d="M6 21.5 12.6 13"/><circle cx="13.6" cy="11.7" r="1.9" fill="currentColor" stroke="none"/><path d="M15.4 9.6c-2-1.3-2.4-3.8-.2-7.1.5 2.3 2.8 3.2 3.3 5.3.5 2.1-1.4 3.3-3.1 1.8z"/>',
  garland:
    '<path d="M2.5 5.5c3 3.6 6 5.3 9.5 5.3s6.5-1.7 9.5-5.3M6 8.6v1.6M12 10.8v1.7M18 8.6v1.6"/><path d="M6 10.2c-1.3 0-2 1.2-2 2.5S4.9 15.5 6 15.5s2-1.5 2-2.8-.7-2.5-2-2.5zM12 12.5c-1.3 0-2 1.2-2 2.5s.9 2.8 2 2.8 2-1.5 2-2.8-.7-2.5-2-2.5zM18 10.2c-1.3 0-2 1.2-2 2.5s.9 2.8 2 2.8 2-1.5 2-2.8-.7-2.5-2-2.5z"/>',
  // a torch standing up, shining: its head, its body, the switch, the light above
  flashlight:
    '<path d="M8 8.5h8l-1.5 3.5v8a1.5 1.5 0 0 1-1.5 1.5h-2A1.5 1.5 0 0 1 9.5 20v-8z"/><path d="M12 15v2M12 2.5V5M7 3.8l1.4 2M17 3.8l-1.4 2"/>',
  // the connection, from headphones up to a TV (headphones, phone, tablet and laptop are above)
  tv: '<rect x="2.5" y="6" width="19" height="12.5" rx="2"/><path d="M8.5 2.5 12 6l3.5-3.5M8 21.5h8"/>',
  // a step back: an arrow turning round to the left
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  // the pencil of «Судоку»: marks, not digits
  pencil: '<path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/><path d="m13.5 6.5 3 3"/>',
  // «Сапер»: a marker on a shut cell, and a fault found
  flag: '<path d="M6 21V3.5"/><path d="M6 4h11l-2.5 4L17 12H6"/>',
  zap: '<path d="M13 2.5 4.5 13.5h6.5l-1 8 8.5-11h-6.5z"/>',
} as const;

export type GameIcon = keyof typeof PATHS;

/** The icon's own drawing (24 × 24), to put inside an SVG board. */
export const iconPaths = (name: GameIcon): string => PATHS[name];

export function icon(name: GameIcon, size = 24): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}
