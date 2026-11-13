import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isProviderUsageId, queryProviderUsage } from "@/lib/provider-usage";
import { requireAuth } from "@/lib/user-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Provider calls spend the deployment's credentials and quota, so they
  // require an account (the SDK runtime reads the caller-supplied agentDir).
  const auth = await requireAuth(request);
  if ("response" in auth) return auth.response;
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });

  let body: { providerId?: unknown };
  try {
    body = await request.json() as { providerId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const providerId = typeof body.providerId === "string" ? body.providerId : "";
  if (!isProviderUsageId(providerId)) return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });

  try {
    const result = await queryProviderUsage(providerId);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({
      providerId,
      status: "query-failed",
      message: "The provider usage query failed.",
    });
  }
}
