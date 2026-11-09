import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../src/catalog/load.ts';
import type { Catalog } from '../src/catalog/schema.ts';

export const FIXTURE_CATALOG = fileURLToPath(new URL('./fixtures/catalog.yaml', import.meta.url));

export function fixtureCatalog(): Catalog {
    return loadCatalog(FIXTURE_CATALOG);
}
