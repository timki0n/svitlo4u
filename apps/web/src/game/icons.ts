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
} as const;

export type GameIcon = keyof typeof PATHS;

export function icon(name: GameIcon, size = 24): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}
