/**
 * The search response shape, as the page reads it.
 * This is the page's OWN parse of the API's answer — not an import of the
 * contract — so the page can reject a body that grew a field or lost one rather
 * than render whatever arrived. Zod `.strip()` (the default) drops what it does
 * not know, so a future `totalHint` will not break this parse or leak into the
 * island.
 */
import { z } from 'zod';

export const searchHitSchema = z.object({
  kind: z.enum(['manga', 'creator', 'tag']),
  id: z.string().min(1),
  slug: z.string().min(1).nullable(),
  title: z.string().min(1),
  matchField: z.enum(['title', 'alias', 'creator', 'tag']),
  band: z.enum(['exact', 'prefix', 'contains', 'related']),
});

export const searchResponseSchema = z.object({
  items: z.array(searchHitSchema),
  nextCursor: z.string().nullable(),
});

export type SearchHitView = z.infer<typeof searchHitSchema>;
