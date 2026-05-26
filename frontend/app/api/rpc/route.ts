import "server-only";

/// Server-side JSON-RPC proxy (ported from Unicurve). Forwards wagmi/viem
/// calls from the browser to our authenticated upstream (Chainstack) without
/// shipping the key in the client bundle. The browser only ever sees the
/// same-origin `/api/rpc` URL.
///
/// Upstream key precedence: RPC_URL (server env). For local dev without it
/// set, falls back to the public Chainstack URL so the app still runs.
const UPSTREAM =
  process.env.RPC_URL ??
  "https://ethereum-mainnet.core.chainstack.com/c85dfde223a44a520f14059dd8f0ed96";

export async function POST(req: Request) {
  if (!UPSTREAM) {
    return new Response(JSON.stringify({ error: "RPC upstream not configured" }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
  // Pass the JSON-RPC body through verbatim.
  const body = await req.text();
  // TEMP DIAGNOSTIC: log eth_call calldata aimed at the factory so we can
  // capture the EXACT create() args the browser sends (visible in `vercel logs`).
  try {
    if (body.includes("0xb6D1660126B0f4C0D9dF81A3f8FD6aAe46FaAf0b".toLowerCase()) ||
        body.toLowerCase().includes("b6d1660126b0f4c0d9df81a3f8fd6aae46faaf0b")) {
      const j = JSON.parse(body);
      const calls = Array.isArray(j) ? j : [j];
      for (const c of calls) {
        if (c?.method === "eth_call" || c?.method === "eth_estimateGas") {
          const p = c.params?.[0] ?? {};
          console.log("[rpc-probe]", c.method, "to=", p.to, "from=", p.from, "dataLen=", (p.data || "").length, "data=", (p.data || "").slice(0, 4000));
        }
      }
    }
  } catch { /* ignore logging errors */ }
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

export function GET() {
  return new Response("method not allowed", { status: 405 });
}
