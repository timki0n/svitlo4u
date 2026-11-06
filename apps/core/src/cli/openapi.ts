/**
 * Writes docs/openapi.json from the API contract. Run after changing apps/core/src/api/contract.ts:
 *   pnpm --filter @svitlo/core openapi
 * A test fails while the committed file differs from the contract.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../api/contract.ts";

export const OPENAPI_PATH = fileURLToPath(
  new URL("../../../../docs/openapi.json", import.meta.url),
);

export function renderOpenApi(): string {
  return `${JSON.stringify(openApiDocument(), null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OPENAPI_PATH, renderOpenApi());
  console.log(`written ${OPENAPI_PATH}`);
}
