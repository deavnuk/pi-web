import { shareModelCatalogRefresh } from "@/lib/model-catalog-refresh";
import { requireAuth } from "@/lib/user-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/models/refresh — fetch the remote provider catalogs now.
 *
 * Body: `{ provider?: string }`. Without one every refreshable provider is
 * passed over, which is what the panel-wide button sends.
 *
 * The response says only whether the pass completed and whether anything
 * moved. The refreshed catalog itself reaches the browser through the
 * `/api/models` and `/api/models/enabled` reloads the caller does next, so
 * there is no second shape of the model list to keep in agreement.
 */
export async function POST(req: Request) {
  // Provider calls spend the deployment's credentials and quota, so they
  // require an account (the SDK runtime reads the caller-supplied agentDir).
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  let provider: string | undefined;
  try {
    const body = await req.json() as { provider?: unknown };
    if (typeof body?.provider === "string" && body.provider.trim()) {
      provider = body.provider.trim();
    }
  } catch {
    // An empty body means "every provider", the same as no provider field.
  }

  const result = await shareModelCatalogRefresh(provider ? { providers: [provider] } : {});
  return Response.json(result);
}
