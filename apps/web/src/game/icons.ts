/** Line icons of the window games (24 × 24, stroked with currentColor). */
const PATHS = {
  cat: '<path d="M5 20c-1-1-1.5-2.5-1.5-4.5V5l4 3.5h9l4-3.5v10.5c0 2-.5 3.5-1.5 4.5-1.6 1.3-4 2-7 2s-5.4-.7-7-2z"/><path d="M9.5 14h.01M14.5 14h.01M11 17.5h2"/>',
  dog: '<path d="M8 4h8a3 3 0 0 1 3 3v8a7 7 0 0 1-14 0V7a3 3 0 0 1 3-3z"/><path d="M5 7 2.5 13.5 5 15M19 7l2.5 6.5L19 15"/><path d="M9.5 11h.01M14.5 11h.01M10.5 15.5h3"/>',
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
} as const;

export type GameIcon = keyof typeof PATHS;

/** The icon's own drawing (24 × 24), to put inside an SVG board. */
export const iconPaths = (name: GameIcon): string => PATHS[name];

export function icon(name: GameIcon, size = 24): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}
