/** Test helper: hub firmware images. */

/** A minimal app image as esptool lays it out: the header, then esp_app_desc_t. */
export function fakeHubImage(
  version: string,
  { chip = 13, project = "svitlo4u_hub", size = 4096 } = {},
): Buffer {
  const b = Buffer.alloc(size, 0x5a);
  b[0] = 0xe9;
  b.writeUInt16LE(chip, 12);
  b.writeUInt32LE(0xabcd5432, 32);
  b.fill(0, 48, 112);
  b.write(version, 48, "latin1");
  b.write(project, 80, "latin1");
  return b;
}
