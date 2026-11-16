import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'genkit';
import { defaultBundle, bundleHash, BundleSchema } from './prompt-bundle.js';

type TuningRequest = {
  method: string;
  path: string;
  auth: { uid: string; token: Record<string, unknown> };
};
const tiers = ['free', 'go', 'pro'] as const;
const sourceSchema = z.literal('compiled-default');
const metadataSchema = z.object({ id: z.enum(tiers), revision: z.string(), modelName: z.string(), bundleHash: z.string() });
export const tuningRoutes = [
  { method: 'GET', path: '/v1/tuning/prompts', operationId: 'listCompiledPrompts', status: 200, response: z.object({ source: sourceSchema, items: z.array(metadataSchema) }) },
  { method: 'GET', path: '/v1/tuning/prompts/{id}', operationId: 'getCompiledPrompt', status: 200, params: z.object({ id: z.enum(tiers) }), response: z.object({ source: sourceSchema, id: z.enum(tiers), bundleHash: z.string(), bundle: BundleSchema }) },
];
/** Caller verifies Firebase ID token and supplies current server-loaded custom claims. */
export async function dispatchTuningApi(input: TuningRequest): Promise<{ status: number; body: unknown }> {
  const { uid, token } = input.auth;
  if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
  if (token.tuningEditor !== true && token.tuningPublisher !== true)
    throw new HttpsError('permission-denied', 'TUNING_PERMISSION_REQUIRED');
  if (input.method !== 'GET') throw new HttpsError('not-found', 'ROUTE_NOT_FOUND');
  const source = 'compiled-default' as const;
  // These are bundled defaults, never represented as published Remote Config or editable drafts.
  if (input.path === '/v1/tuning/prompts') return {
    status: 200,
    body: tuningRoutes[0].response.parse({ source, items: tiers.map(id => {
      const bundle = defaultBundle(id);
      return { id, revision: bundle.revision, modelName: bundle.modelName, bundleHash: bundleHash(bundle) };
    }) }),
  };
  const match = /^\/v1\/tuning\/prompts\/(free|go|pro)$/.exec(input.path);
  if (!match) throw new HttpsError('not-found', 'ROUTE_NOT_FOUND');
  const id = match[1] as typeof tiers[number], bundle = defaultBundle(id);
  return { status: 200, body: tuningRoutes[1].response.parse({ source, id, bundleHash: bundleHash(bundle), bundle }) };
}
