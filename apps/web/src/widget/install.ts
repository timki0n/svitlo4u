/**
 * The Scriptable script as the install page hands it out: set to the building being looked at and
 * to the site it came from.
 */
export function scriptFor(source: string, siteId: string, origin: string): string {
  const set = (text: string, name: string, value: string) => {
    const line = new RegExp(`^const ${name} = ".*";$`, "m");
    if (!line.test(text)) throw new Error(`scriptable.js has no ${name} line`);
    return text.replace(line, `const ${name} = ${JSON.stringify(value)};`);
  };
  return set(set(source, "SITE", siteId), "ORIGIN", origin);
}
