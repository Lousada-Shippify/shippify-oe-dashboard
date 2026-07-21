// Cloudflare Worker — proxy ao vivo para o dashboard OE.
// Guarda o token do Jira como segredo do Worker (nunca aparece no site público).
// O botão "Atualizar" do dashboard chama este endpoint na hora do clique e recebe
// dados frescos do Jira, sem precisar esperar o ciclo do GitHub Action.
//
// Segredos necessários (definidos com `wrangler secret put NOME`):
//   JIRA_BASE_URL   ex.: https://shippify.atlassian.net
//   JIRA_EMAIL      seu e-mail Atlassian
//   JIRA_API_TOKEN  token em https://id.atlassian.com/manage-profile/security/api-tokens
//
// Origem permitida (CORS) — troque se publicar em outra URL do GitHub Pages.
const ALLOWED_ORIGIN = 'https://lousada-shippify.github.io';

const ACTIVE_FIELDS = ['summary','status','assignee','issuetype','priority','duedate','sprint','customfield_10020','customfield_10028','customfield_10546','parent'];
const DONE_FIELDS   = ['summary','status','assignee','issuetype','priority','sprint','customfield_10020','customfield_10028','customfield_10546','resolutiondate','updated','parent'];

const JQL_ACTIVE = 'sprint in openSprints() AND project = "OE" AND statusCategory != Done ORDER BY priority ASC, updated DESC';
const JQL_DONE   = 'sprint in openSprints() AND project = "OE" AND statusCategory = Done ORDER BY resolutiondate ASC';

function corsHeaders(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

async function searchAll(env, jql, fields) {
  const BASE = (env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const AUTH = 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
  const out = [];
  let nextPageToken;
  for (let i = 0; i < 20; i++) {
    const body = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Jira ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    for (const issue of data.issues || []) out.push({ key: issue.key, fields: issue.fields });
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/jira') {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    // Micro-cache de borda (20s) para absorver cliques repetidos sem sobrecarregar o Jira.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const [active, done] = await Promise.all([
        searchAll(env, JQL_ACTIVE, ACTIVE_FIELDS),
        searchAll(env, JQL_DONE, DONE_FIELDS),
      ]);
      const body = JSON.stringify({ active, done, generatedAt: new Date().toISOString() });
      const res = new Response(body, {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20' },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err && err.message || err) }), {
        status: 502,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }
  },
};
