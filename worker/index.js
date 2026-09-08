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

const ACTIVE_FIELDS = ['summary','status','assignee','issuetype','priority','duedate','sprint','customfield_10020','customfield_10028','customfield_10546','customfield_10548','parent'];
const DONE_FIELDS   = ['summary','status','assignee','issuetype','priority','sprint','customfield_10020','customfield_10028','customfield_10546','customfield_10548','resolutiondate','updated','parent'];

const JQL_ACTIVE = 'sprint in openSprints() AND project = "OE" AND statusCategory != Done ORDER BY priority ASC, updated DESC';
const JQL_DONE   = 'sprint in openSprints() AND project = "OE" AND statusCategory = Done ORDER BY resolutiondate ASC';

// Board da squad OE — usado pelo endpoint /sprints (catálogo do filtro de histórico).
const BOARD_ID = 474;

// JQL para sprints escolhidas no filtro de histórico (ids validados como inteiros).
const jqlSprints = (ids, done) =>
  `sprint in (${ids.join(',')}) AND project = "OE" AND statusCategory ${done ? '=' : '!='} Done ` +
  (done ? 'ORDER BY resolutiondate ASC' : 'ORDER BY priority ASC, updated DESC');

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
// Paradas: statuses em que o card fica esperando alguém/algo. O tempo somado nestes
// estados é o "tempo parado" que alimenta o painel Histórico.
const BLOCKED_RE = /(BLOCKED|WAITING\s*FOR\s*TASKS)/i;

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
  const blank = () => ({ code: 0, qa: 0, tQA: false, tCR: false, blkMs: 0, blkN: 0, _blkFrom: null, hist: [] });
  for (const id of issueIds) rej[id] = blank();
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
      if (!rej[id]) rej[id] = blank();
      for (const h of (entry.changeHistories || [])) {
        for (const item of (h.items || [])) {
          if (item.field !== 'status' && item.fieldId !== 'status') continue;
          const to = item.toString || '';
          if (QA_STAGE_RE.test(to)) rej[id].tQA = true;
          if (CR_STAGE_RE.test(to)) rej[id].tCR = true;
          const kind = rejKind(to);
          if (kind === 'qa') rej[id].qa++;
          else if (kind === 'code') rej[id].code++;
          // guarda a transição para calcular tempo parado depois de ordenar por data
          rej[id].hist.push({ t: Date.parse(h.created || '') || 0, to });
        }
      }
    }
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  // Tempo parado: soma dos intervalos entre entrar num status de bloqueio e sair dele.
  // O bulkfetch não garante ordem, então ordenamos por data antes de fechar os intervalos.
  // Um bloqueio ainda aberto conta até agora.
  const now = Date.now();
  for (const id of Object.keys(rej)) {
    const r = rej[id];
    r.hist.sort((a, b) => a.t - b.t);
    let from = null;
    for (const ev of r.hist) {
      const blocked = BLOCKED_RE.test(ev.to);
      if (blocked && from === null) { from = ev.t; r.blkN++; }
      else if (!blocked && from !== null) { r.blkMs += Math.max(0, ev.t - from); from = null; }
    }
    if (from !== null) r.blkMs += Math.max(0, now - from);
    delete r.hist;
  }
  return rej;
}

// Catálogo de sprints do board (para o filtro de histórico no front).
async function fetchSprints(env) {
  const BASE = (env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const AUTH = 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
  const out = [];
  for (let startAt = 0, page = 0; page < 10; page++) {
    const res = await fetch(
      `${BASE}/rest/agile/1.0/board/${BOARD_ID}/sprint?state=active,closed&maxResults=50&startAt=${startAt}`,
      { headers: { Authorization: AUTH, Accept: 'application/json' } }
    );
    if (!res.ok) throw new Error(`Jira sprints ${res.status}`);
    const data = await res.json();
    for (const s of (data.values || [])) {
      out.push({ id: s.id, name: s.name, state: s.state, startDate: s.startDate || null,
                 endDate: s.endDate || null, completeDate: s.completeDate || null });
    }
    if (data.isLast || !(data.values || []).length) break;
    startAt += (data.values || []).length;
  }
  out.sort((a, b) => b.id - a.id);
  return out;
}

async function buildPayload(env, sprintIds) {
  const hist = Array.isArray(sprintIds) && sprintIds.length > 0;
  const [active, done] = await Promise.all([
    searchAll(env, hist ? jqlSprints(sprintIds, false) : JQL_ACTIVE, ACTIVE_FIELDS),
    searchAll(env, hist ? jqlSprints(sprintIds, true)  : JQL_DONE,   DONE_FIELDS),
  ]);
  const ids = [...active, ...done].map(i => i.id).filter(Boolean);
  let rej = {};
  try { rej = await fetchRejections(env, ids); } catch (e) { /* fallback: sem rejeições */ }
  const attach = i => {
    const r = rej[i.id] || { code: 0, qa: 0, tQA: false, tCR: false, blkMs: 0, blkN: 0 };
    i._rejCode = r.code; i._rejQA = r.qa;
    i._blkMs = r.blkMs || 0; i._blkN = r.blkN || 0;
    // Base do índice de retorno: chegou ao estágio (changelog) ou já está nele agora.
    const cur = i.fields?.status?.name || '';
    i._touchQA = !!(r.tQA || r.qa > 0 || QA_STAGE_RE.test(cur));
    i._touchCR = !!(r.tCR || r.code > 0 || CR_STAGE_RE.test(cur));
    return i;
  };
  active.forEach(attach);
  done.forEach(attach);
  return { active, done, sprints: hist ? sprintIds : null, generatedAt: new Date().toISOString() };
}

// ?sprints=1270,1275 → lista de ids inteiros (máx. 12, para não estourar o timeout do Worker)
function parseSprintIds(url) {
  const raw = url.searchParams.get('sprints');
  if (!raw) return null;
  const ids = raw.split(',').map(v => parseInt(v, 10)).filter(v => Number.isInteger(v) && v > 0);
  return ids.length ? [...new Set(ids)].slice(0, 12) : null;
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

    if (url.pathname === '/sprints') {
      const cacheS = caches.default;
      const keyS = new Request(url.toString(), request);
      const hitS = await cacheS.match(keyS);
      if (hitS) return hitS;
      try {
        const body = JSON.stringify({ sprints: await fetchSprints(env), generatedAt: new Date().toISOString() });
        // O catálogo muda no máximo a cada duas semanas — 5 min de cache de borda é folgado.
        const res = new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
        ctx.waitUntil(cacheS.put(keyS, res.clone()));
        return res;
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 502, headers: { ...headers, 'Content-Type': 'application/json' } });
      }
    }

    if (url.pathname !== '/jira') {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const sprintIds = parseSprintIds(url);
      const body = JSON.stringify(await buildPayload(env, sprintIds));
      // Sprint fechada não muda mais: cache longo. Sprint aberta segue em 20s.
      const maxAge = sprintIds ? 900 : 20;
      const res = new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}` } });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 502, headers: { ...headers, 'Content-Type': 'application/json' } });
    }
  },
};
