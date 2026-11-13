import { invalidateModelsCache } from "@/lib/models-cache";
import { removeStoredCredentialIfType } from "@/lib/provider-credential-store";
import { createModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { requireAuth } from "@/lib/user-auth";
import { join } from "path";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const { provider } = await params;
  const modelRuntime = await createModelRuntimeWithExtensions(auth.user?.agentDir);
  if (!modelRuntime.getProvider(provider)?.auth.oauth) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }
  const authPath = auth.user ? join(auth.user.agentDir, "auth.json") : undefined;
  const removal = await removeStoredCredentialIfType(provider, "oauth", authPath);
  if (removal.status === "type_mismatch") {
    return Response.json({ error: `${provider} is authenticated with an API key, not OAuth` }, { status: 409 });
  }
  invalidateModelsCache();
  return Response.json({ ok: true });
}
