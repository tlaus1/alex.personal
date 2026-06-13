// Anthropic chat proxy — keeps the API key server-side (in Supabase secrets).
// The dashboard POSTs { messages, model, system? } here; we forward to Anthropic
// and stream the response back. The key never reaches the browser.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
// Shared secret — the dashboard sends this in the x-dashboard-token header.
// Set it with: supabase secrets set DASHBOARD_TOKEN=<random-string>
// If unset, the gate is disabled (so the function still works during setup).
const DASHBOARD_TOKEN = Deno.env.get("DASHBOARD_TOKEN") ?? "";

// CORS is NOT the security boundary here — the DASHBOARD_TOKEN header is.
// So we reflect whatever Origin calls us, which means the dashboard works from
// any domain (alexfun.is-a.dev, alexpersonal.is-a.dev, tlaus1.github.io, local
// preview, etc.) without maintaining an allow-list. A caller still needs the
// secret token to actually use the function.

// Models the dashboard is allowed to request. Guards against someone tampering
// with the client to request an arbitrary (expensive) model string.
const ALLOWED_MODELS = new Set([
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
]);

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-dashboard-token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  const cors = corsHeaders(origin);

  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "Server missing ANTHROPIC_API_KEY" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Shared-secret gate. CORS only stops browsers; this stops scripts/curl too.
  if (DASHBOARD_TOKEN) {
    const provided = req.headers.get("x-dashboard-token");
    if (provided !== DASHBOARD_TOKEN) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }

  let body: { messages?: unknown; model?: string; system?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const model = typeof body.model === "string" && ALLOWED_MODELS.has(body.model)
    ? body.model
    : "claude-sonnet-4-6";

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages must be a non-empty array" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Forward to Anthropic with streaming enabled.
  const anthropicReq: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    stream: true,
    messages: body.messages,
  };
  if (typeof body.system === "string" && body.system.trim()) {
    anthropicReq.system = body.system;
  }

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(anthropicReq),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(
      JSON.stringify({ error: `Anthropic ${upstream.status}`, detail: errText }),
      { status: upstream.status, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  // Stream the SSE response straight back to the dashboard.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});
