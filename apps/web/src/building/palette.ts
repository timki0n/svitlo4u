/** Colours of the clay figure and how it looks with light, with low voltage and without. */

export const PALETTE = {
  clay: "#80838d",
  clayDark: "#686b75",
  tree: "#5f6e60",
  court: "#76625c",
  glass: "#202228",
  lamp: "#ffb347",
  lampCool: "#ffd58a",
  lampLow: "#ff8f3a",
  gen: "#ffd58a",
  sky: "#9a9ca3",
  shadow: "#08090a",
  /** The openings of the stair loggias: shade, lighter than glass. */
  loggia: "#5a5d66",
  /** Balcony parapets: the clay a little warmer and lighter (the yellow panels of panel houses). */
  parapet: "#8f8b80",
};

export const STATES = {
  on: {
    lamp: 1,
    hemi: 1.55,
    sun: 0.85,
    bars: 0.75,
    bar: PALETTE.lampCool,
    flicker: false,
    sign: 0.9,
  },
  low: {
    lamp: 0.55,
    hemi: 1.4,
    sun: 0.75,
    bars: 0.55,
    bar: PALETTE.lampLow,
    flicker: true,
    sign: 0.5,
  },
  off: { lamp: 0, hemi: 0.95, sun: 0.35, bars: 1, bar: PALETTE.gen, flicker: false, sign: 0 },
} as const;
