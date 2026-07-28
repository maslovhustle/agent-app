import { serve } from 'inngest/next';

import { inngest } from '@/lib/inngest/client';
import { functions } from '@/lib/inngest/functions';

/**
 * Inngest's webhook endpoint. Inngest calls back into this route to execute
 * each durable step, which is why ingestion survives a deploy mid-run.
 *
 * Locally: `pnpm inngest:dev` starts the dev server that discovers this route.
 */
export const runtime = 'nodejs';
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
