// Cloudflare Worker — proxy ao vivo para o dashboard OE.
// Guarda o token do Jira como segredo do Worker (nunca aparece no site público).
// Além das issues da sprint, calcula por issue o nº de rejeições (código e QA) a
// partir do CHANGELOG — assim contamos rejeições mesmo que a tarefa já tenha sido
// corrigida e saído do status de rejeição, e contamos múltiplas rejeições da mesma.
//
// Segredos necessários (wrangler secret / painel Cloudflare):
//   JIRA_BASE_URL   ex.: https://shippify.atlassian.net
//   JIRA_EMAIL      seu e-mail Atlassian
//   JIRA_API_TOKEN  token em id.atlassian.com/manage-profile/security/api-tokens
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

// Estágios (BASE dos índices de retorno): a issue CHEGOU ao QA / ao code review pelo menos uma vez.
// O denominador do índice é "cards que passaram pelo estágio", não o escopo inteiro da sprint.
const QA_STAGE_RE = /(PENDING\s*QA|ON\s*GOING\s*QA|ON\s*TESTING|APPROVED\s*BY\s*QA|QA\s*VERIFIED|REJECTED\s*BY\s*QA|QA\s*DENIED)/i;
const CR_STAGE_RE = /(CODE\s*REVIEW|PR\s*REVIEW|PULL\s*REQUEST)/i;

// Classifica uma transição de status como rejeição de CÓDIGO, de QA, ou nenhuma.
// Statuses reais do Jira (confirmados no changelog de OE-140): "CODE REVIEW REJECTED" e
// "REJECTED BY QA" / "QA DENIED". São rejeições DISTINTAS e cada uma alimenta o seu índice.
// Mesmas expressões do Weekly Product Hub (build.mjs / worker.js) — os dois dashboards devem
// devolver exatamente o mesmo número para a mesma squad.
const REJECT_CODE_RE = /CODE\s*REVIEW\s*REJECTED/i;
const REJECT_QA_RE   = /REJECTED\s*BY\s*QA|QA\s*DENIED/i;
function rejKind(statusName) {
  const s = statusName || '';
  if (REJECT_QA_RE.test(s)) return 'qa';
  if (REJECT_CODE_RE.test(s)) return 'code';
  return null;
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
    for (const issue of data.issues || []) out.push({ id: issue.id, key: issue.key, fields: issue.fields });
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return out;
}

// Busca o histórico de status (changelog) em lote e devolve um mapa
// issueId → { code, qa } com a contagem de transições PARA um status de rejeição.
async function fetchRejections(env, issueIds) {
  const BASE = (env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const AUTH = 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
  const rej = {};
  for (const id of issueIds) rej[id] = { code: 0, qa: 0, tQA: false, tCR: false };
  if (!issueIds.length) return rej;

  // Endpoint bulk: paginado. Enviamos todos os ids e iteramos as páginas.
  let nextPageToken;
  for (let page = 0; page < 40; page++) {
    const body = { issueIdsOrKeys: issueIds, fieldIds: ['status'], maxResults: 1000 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await fetch(`${BASE}/rest/api/3/changelog/bulkfetch`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) break; // se o endpoint falhar, devolve zeros (fallback seguro)
    const data = await res.json();
    for (const entry of (data.issueChangeLogs || [])) {
      const id = entry.issueId;
      if (!rej[id]) rej[id] = { code: 0, qa: 0, tQA: false, tCR: false };
      for (const h of (entry.changeHistories || [])) {
        for (const item of (h.items || [])) {
          if (item.field !== 'status' && item.fieldId !== 'status') continue;
          const to = item.toString || '';
          if (QA_STAGE_RE.test(to)) rej[id].tQA = true;
          if (CR_STAGE_RE.test(to)) rej[id].tCR = true;
          const kind = rejKind(to);
          if (kind === 'qa') rej[id].qa++;
          else if (kind === 'code') rej[id].code++;
        }
      }
    }
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return rej;
}

async function buildPayload(env) {
  const [active, done] = await Promise.all([
    searchAll(env, JQL_ACTIVE, ACTIVE_FIELDS),
    searchAll(env, JQL_DONE, DONE_FIELDS),
  ]);
  const ids = [...active, ...done].map(i => i.id).filter(Boolean);
  let rej = {};
  try { rej = await fetchRejections(env, ids); } catch (e) { /* fallback: sem rejeições */ }
  const attach = i => {
    const r = rej[i.id] || { code: 0, qa: 0, tQA: false, tCR: false };
    i._rejCode = r.code; i._rejQA = r.qa;
    // Base do índice de retorno: chegou ao estágio (changelog) ou já está nele agora.
    const cur = i.fields?.status?.name || '';
    i._touchQA = !!(r.tQA || r.qa > 0 || QA_STAGE_RE.test(cur));
    i._touchCR = !!(r.tCR || r.code > 0 || CR_STAGE_RE.test(cur));
    return i;
  };
  active.forEach(attach);
  done.forEach(attach);
  return { active, done, generatedAt: new Date().toISOString() };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const url = new URL(request.url);

    if (url.pathname === '/debug') {
      const BASE = (env.JIRA_BASE_URL || '').replace(/\/+$/, '');
      const info = { hasBaseUrl: !!env.JIRA_BASE_URL, hasEmail: !!env.JIRA_EMAIL, hasToken: !!env.JIRA_API_TOKEN, baseUrlHost: (()=>{try{return new URL(BASE).host;}catch{return BASE;}})() };
      try {
        const p = await buildPayload(env);
        const all = [...p.active, ...p.done];
        info.issueCount = all.length;
        info.rejected = all.filter(i => (i._rejCode + i._rejQA) > 0)
          .map(i => ({ key: i.key, assignee: i.fields?.assignee?.displayName || '—', status: i.fields?.status?.name, rejCode: i._rejCode, rejQA: i._rejQA }));
        info.totalRejCode = all.reduce((s,i)=>s+i._rejCode,0);
        info.totalRejQA   = all.reduce((s,i)=>s+i._rejQA,0);
      } catch (e) { info.error = String(e && e.message || e); }
      return new Response(JSON.stringify(info, null, 2), { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    if (url.pathname !== '/jira') {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const body = JSON.stringify(await buildPayload(env));
      const res = new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20' } });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 502, headers: { ...headers, 'Content-Type': 'application/json' } });
    }
  },
};
