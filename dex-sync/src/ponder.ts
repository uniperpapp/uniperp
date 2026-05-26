// Enumerates launched tokens via the Ponder indexer's auto-generated
// GraphQL endpoint. Safer than reading the indexer's Postgres tables
// directly (Ponder namespaces every build, so the SQL table name changes
// on each reindex).

const PONDER_GRAPHQL = process.env.PONDER_GRAPHQL_URL ?? "http://localhost:42069/graphql";

export interface LaunchRef {
  hook: `0x${string}`;
  token: `0x${string}`;
  base: `0x${string}`;
}

export async function fetchLaunches(): Promise<LaunchRef[]> {
  const query = `{
    launchs(limit: 1000, orderBy: "createdAt", orderDirection: "asc") {
      items { id token base }
    }
  }`;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 8_000);
  try {
    const r = await fetch(PONDER_GRAPHQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: ctl.signal,
    });
    if (!r.ok) return [];
    const j = (await r.json()) as any;
    const items: any[] = j?.data?.launchs?.items ?? [];
    return items.map((x) => ({
      hook:  x.id    as `0x${string}`,
      token: x.token as `0x${string}`,
      base:  x.base  as `0x${string}`,
    }));
  } catch { return []; }
  finally { clearTimeout(to); }
}
