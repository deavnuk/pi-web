import { join } from "path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ModelsConfigReadError, readModelsConfig, writeModelsConfig, getModelsConfigPath } from "@/lib/models-config-store";
import { requireAuth } from "@/lib/user-auth";

export const dynamic = "force-dynamic";

function modelsConfigPathFor(userAgentDir: string | undefined): string {
  // Multi-user: each user manages the models.json inside their own agentDir.
  return userAgentDir ? join(userAgentDir, "models.json") : getModelsConfigPath();
}

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;
  try {
    return NextResponse.json(readModelsConfig(modelsConfigPathFor(user?.agentDir ?? getAgentDir())));
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;
  try {
    const body = await req.json() as Record<string, unknown>;
    writeModelsConfig(body, modelsConfigPathFor(user?.agentDir ?? getAgentDir()));
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
