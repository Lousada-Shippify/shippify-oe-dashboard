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

const ACTIVE_FIELDS = ['summary','status','assignee','issuetype','priority','duedate','sprint','updated','customfield_10020','customfield_10028','customfield_10546','customfield_10548','parent'];
const DONE_FIELDS   = ['summary','status','assignee','issuetype','priority','sprint','customfield_10020','customfield_10028','customfield_10546','customfield_10548','resolutiondate','statuscategorychangedate','updated','duedate','parent'];

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
  const blank = () => ({ code: 0, qa: 0, tQA: false, tCR: false, blk: [], blkN: 0, hist: [] });
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
          // guarda a transição para calcular tempo parado depois de ordenar por data.
          // Timestamp inválido é DESCARTADO: com t=0 um bloqueio aberto virava "parado
          // desde 1970" e somava ~57 anos ao total.
          const t = Date.parse(h.created || '');
          if (Number.isFinite(t) && t > 0) rej[id].hist.push({ t, to });
        }
      }
    }
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  // Tempo parado: devolvemos os INTERVALOS crus [inicio, fim] em ms, não um total.
  // O front recorta cada intervalo pela janela da sprint analisada — "parado" tem que
  // significar parado DURANTE aquela sprint, não desde sempre. Intervalo ainda aberto
  // vai com fim = 0 e o front fecha em min(agora, fim da sprint).
  // O bulkfetch não garante ordem, então ordenamos por data antes de fechar os intervalos.
  for (const id of Object.keys(rej)) {
    const r = rej[id];
    r.hist.sort((a, b) => a.t - b.t);
    let from = null;
    for (const ev of r.hist) {
      const blocked = BLOCKED_RE.test(ev.to);
      if (blocked && from === null) from = ev.t;
      else if (!blocked && from !== null) { if (ev.t > from) r.blk.push([from, ev.t]); from = null; }
    }
    if (from !== null) r.blk.push([from, 0]);
    r.blkN = r.blk.length;
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
    const r = rej[i.id] || { code: 0, qa: 0, tQA: false, tCR: false, blk: [], blkN: 0 };
    i._rejCode = r.code; i._rejQA = r.qa;
    i._blk = r.blk || []; i._blkN = r.blkN || 0;
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

// ── /metrics — agregado pronto para consumo externo (Mika / reportes) ────────
// Fonte única de verdade: calcula aqui, com as MESMAS regras do painel, tudo o que
// um reporte diário precisa. Quem consome não recalcula nada e não pode divergir.
// Regras espelhadas do index.html:
//   1. Progresso/escopo = somente issues-PAI (subtarefa nunca entra no SP).
//   2. DEV + QA = Story Points (dev = customfield_10548 ou SP − QA; QA = 10546).
//   3. Rejeições vêm do CHANGELOG (_rejCode/_rejQA), nunca do status atual.
//   4. Dias restantes = dias ÚTEIS, data parseada em horário local (America/Sao_Paulo).
//   5. CANCEL fica fora de tudo.
const QA_NAME = 'Nataly Brasiliano';
const NAME_ALIAS = { 'Jira Triage Agent': 'Reuniões ou Treinamentos' };

const mNum = v => (v !== null && v !== undefined && v !== '' && !isNaN(Number(v))) ? Number(v) : 0;
const mSP = i => mNum(i?.fields?.customfield_10028);
const mQASP = i => mNum(i?.fields?.customfield_10546);
const mDevSP = i => {
  const dev = i?.fields?.customfield_10548;
  if (dev !== null && dev !== undefined && dev !== '' && !isNaN(Number(dev))) return Number(dev);
  return Math.max(0, mSP(i) - mQASP(i));
};
const mCat = i => (i?.fields?.status?.statusCategory?.key || '');
const mStatus = i => (i?.fields?.status?.name || '—');
const mIsSub = i => !!(i?.fields?.issuetype?.subtask) || (i?.fields?.issuetype?.hierarchyLevel === -1);
const mIsCancel = i => mCat(i) === 'done' && /cancel|discard|descart/i.test(mStatus(i));
const mAssignee = i => {
  const n = i?.fields?.assignee?.displayName || null;
  return n ? (NAME_ALIAS[n] || n) : null;
};
const mSprint = i => {
  const arr = i?.fields?.customfield_10020;
  if (!Array.isArray(arr)) return null;
  return arr.find(s => s && s.state === 'active') || arr[arr.length - 1] || null;
};

// Dia local (fuso -03) a partir de 'YYYY-MM-DD…' — evita o erro de −1 dia do new Date(iso).
function mLocalDay(str) {
  if (!str) return null;
  const p = String(str).split('T')[0].split('-').map(Number);
  if (p.length < 3 || p.some(n => !Number.isFinite(n))) return null;
  return Date.UTC(p[0], p[1] - 1, p[2]);
}
function mTodayLocal() {
  const d = new Date(Date.now() - 3 * 3600 * 1000); // America/Sao_Paulo
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function mBusinessDaysUntil(dateStr) {
  const end = mLocalDay(dateStr); if (end === null) return null;
  let cur = mTodayLocal();
  if (end <= cur) return 0;
  let count = 0;
  while (cur < end) {
    cur += 86400000;
    const dow = new Date(cur).getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}
function mBusinessDayList(startStr, endStr) {
  const s = mLocalDay(startStr), e = mLocalDay(endStr);
  if (s === null || e === null) return [];
  const out = [];
  for (let d = s; d <= e; d += 86400000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}
const mFmt = d => { const x = new Date(d); return String(x.getUTCDate()).padStart(2, '0') + '/' + String(x.getUTCMonth() + 1).padStart(2, '0'); };
const mDaysSince = iso => { const t = mLocalDay(iso); return t === null ? null : Math.round((mTodayLocal() - t) / 86400000); };
const mRound = n => Math.round(n * 100) / 100;

// Ordem do fluxo OE, para o gráfico de SP por status sair na sequência certa.
const FLOW_ORDER = ['Tarefas pendentes','WAITING FOR TASKS','Sendo feito','BLOCKED','CODE REVIEW','CODE REVIEW REJECTED','PENDING QA','ON GOING QA','REJECTED BY QA','APPROVED BY QA','QA VERIFIED','WAITING FOR DEPLOY/RELEASE','Concluído'];
const flowIdx = s => { const i = FLOW_ORDER.findIndex(f => f.toLowerCase() === String(s).toLowerCase()); return i < 0 ? 50 : i; };

function buildMetrics(payload) {
  const raw = [...(payload.active || []), ...(payload.done || [])].filter(i => !mIsCancel(i));
  const parents = raw.filter(i => !mIsSub(i));
  const subs = raw.filter(mIsSub);

  const done = parents.filter(i => mCat(i) === 'done');
  const active = parents.filter(i => mCat(i) === 'indeterminate');
  const todo = parents.filter(i => mCat(i) !== 'done' && mCat(i) !== 'indeterminate');

  const totalSP = parents.reduce((s, i) => s + mSP(i), 0);
  const doneSP = done.reduce((s, i) => s + mSP(i), 0);
  const activeSP = active.reduce((s, i) => s + mSP(i), 0);
  const todoSP = Math.max(0, totalSP - doneSP - activeSP);
  const pct = v => totalSP ? Math.round(v / totalSP * 100) : 0;

  // Sprint
  const sp = parents.map(mSprint).find(Boolean) || {};
  const sprint = {
    id: sp.id || null, name: sp.name || null,
    startDate: sp.startDate || null, endDate: sp.endDate || null,
    businessDaysLeft: sp.endDate ? mBusinessDaysUntil(sp.endDate) : null,
    cards: parents.length, cardsDone: done.length,
  };

  // SP por status (issues-pai), na ordem do fluxo
  const byStatus = {};
  for (const i of parents) {
    const k = mStatus(i);
    (byStatus[k] = byStatus[k] || { status: k, sp: 0, cards: 0 }).sp += mSP(i);
    byStatus[k].cards++;
  }
  const spByStatus = Object.values(byStatus)
    .map(r => ({ ...r, sp: mRound(r.sp) }))
    .sort((a, b) => flowIdx(a.status) - flowIdx(b.status) || b.sp - a.sp);

  // Pessoas: DEV por responsável do pai; QA inteiro na QA da squad. DEV + QA = escopo.
  const people = {};
  const row = n => (people[n] = people[n] || { name: n, devSP: 0, qaSP: 0, doneDevSP: 0, doneQASP: 0, cards: 0, cardsDone: 0, rejCode: 0, rejQA: 0 });
  for (const i of parents) {
    const n = mAssignee(i) || 'Sem responsável';
    const r = row(n);
    const d = mDevSP(i);
    r.devSP += d; r.cards++;
    if (mCat(i) === 'done') { r.doneDevSP += d; r.cardsDone++; }
    const q = mQASP(i);
    if (q > 0) { const qa = row(QA_NAME); qa.qaSP += q; if (mCat(i) === 'done') qa.doneQASP += q; }
  }
  // Rejeições contam em TODAS as issues (pai + subtarefa), somadas no responsável.
  let rejCode = 0, rejQA = 0, touchedCR = 0, touchedQA = 0;
  const rejCards = [];
  for (const i of raw) {
    const c = i._rejCode || 0, q = i._rejQA || 0;
    rejCode += c; rejQA += q;
    // _touch* vem do Worker; no snapshot da Action pode faltar, então reconstruímos
    // pelo que dá para saber ali (já rejeitado ou está no estágio agora).
    const st = mStatus(i);
    if (i._touchCR || c > 0 || CR_STAGE_RE.test(st)) touchedCR++;
    if (i._touchQA || q > 0 || QA_STAGE_RE.test(st)) touchedQA++;
    if (c + q > 0) {
      const n = mAssignee(i) || 'Sem responsável';
      const r = row(n); r.rejCode += c; r.rejQA += q;
      rejCards.push({ key: i.key, summary: i.fields?.summary || '', assignee: n, status: mStatus(i), code: c, qa: q, total: c + q, subtask: mIsSub(i) });
    }
  }
  rejCards.sort((a, b) => b.total - a.total);

  // Bloqueados e parados (3+ dias sem atualização, em andamento)
  const blocked = parents.filter(i => /block/i.test(mStatus(i)) || /waiting\s*for\s*tasks/i.test(mStatus(i)))
    .map(i => ({ key: i.key, summary: i.fields?.summary || '', assignee: mAssignee(i) || '—', status: mStatus(i), sp: mSP(i), blockedSpells: i._blkN || 0 }));
  const stalled = active.filter(i => (mDaysSince(i.fields?.updated) ?? 0) >= 3)
    .map(i => ({ key: i.key, summary: i.fields?.summary || '', assignee: mAssignee(i) || '—', status: mStatus(i), daysIdle: mDaysSince(i.fields?.updated) }))
    .sort((a, b) => b.daysIdle - a.daysIdle);

  // Foco do dia
  const waitingRelease = parents.filter(i => /deploy|release/i.test(mStatus(i)))
    .map(i => ({ key: i.key, summary: i.fields?.summary || '', assignee: mAssignee(i) || '—', sp: mSP(i) }));
  const dueSoon = parents.filter(i => i.fields?.duedate && mCat(i) !== 'done' && (mBusinessDaysUntil(i.fields.duedate) ?? 99) <= 3)
    .map(i => ({ key: i.key, summary: i.fields?.summary || '', assignee: mAssignee(i) || '—', duedate: i.fields.duedate, businessDaysLeft: mBusinessDaysUntil(i.fields.duedate) }))
    .sort((a, b) => a.businessDaysLeft - b.businessDaysLeft);
  const unassigned = parents.filter(i => !i.fields?.assignee && mCat(i) !== 'done')
    .map(i => ({ key: i.key, summary: i.fields?.summary || '', status: mStatus(i), priority: i.fields?.priority?.name || null }));
  const highPriority = parents.filter(i => ['Highest','High'].includes(i.fields?.priority?.name) && mCat(i) !== 'done' && !/block/i.test(mStatus(i)))
    .map(i => ({ key: i.key, summary: i.fields?.summary || '', assignee: mAssignee(i) || '—', priority: i.fields.priority.name, status: mStatus(i) }));

  // Burndown por dia útil. Data da conclusão: resolutiondate e, quando o Jira não
  // preenche (acontece nesta squad), statuscategorychangedate — o dia em que o card
  // entrou em Done. Sem nenhuma das duas, o SP cai no primeiro dia útil da sprint.
  const days = mBusinessDayList(sprint.startDate, sprint.endDate);
  const today = mTodayLocal();
  const labels = days.map(mFmt);
  const ideal = days.map((_, idx) => days.length > 1 ? mRound(totalSP * (1 - idx / (days.length - 1))) : 0);
  const doneByDay = new Map();
  for (const i of done) {
    const when = mLocalDay(i.fields?.resolutiondate || i.fields?.statuscategorychangedate) ?? days[0];
    let slot = days.find(d => d >= when);
    if (slot === undefined) slot = days[days.length - 1];
    doneByDay.set(slot, (doneByDay.get(slot) || 0) + mSP(i));
  }
  let acc = 0;
  const actual = days.map(d => {
    acc += (doneByDay.get(d) || 0);
    return d > today ? null : mRound(totalSP - acc);
  });
  const lastIdx = days.reduce((last, d, idx) => (d <= today ? idx : last), -1);
  const vsIdeal = lastIdx >= 0 ? mRound((actual[lastIdx] ?? 0) - ideal[lastIdx]) : null;

  return {
    schema: 'oe-metrics/1',
    generatedAt: payload.generatedAt,
    source: 'OE Morning Dashboard · https://lousada-shippify.github.io/shippify-oe-dashboard/',
    sprint,
    scope: { sp: mRound(totalSP), cards: parents.length, subtasks: subs.length },
    progress: {
      doneSP: mRound(doneSP), activeSP: mRound(activeSP), todoSP: mRound(todoSP),
      donePct: pct(doneSP), activePct: pct(activeSP), todoPct: pct(todoSP),
      doneCards: done.length, activeCards: active.length, todoCards: todo.length,
    },
    spByStatus,
    people: Object.values(people).map(p => ({
      name: p.name, firstName: p.name.split(' ')[0],
      devSP: mRound(p.devSP), qaSP: mRound(p.qaSP), totalSP: mRound(p.devSP + p.qaSP),
      doneSP: mRound(p.doneDevSP + p.doneQASP), cards: p.cards, cardsDone: p.cardsDone,
      rejCode: p.rejCode, rejQA: p.rejQA,
    })).sort((a, b) => b.totalSP - a.totalSP),
    rejections: {
      code: rejCode, qa: rejQA, total: rejCode + rejQA,
      touchedCR, touchedQA,
      returnIndexCR: touchedCR ? mRound(rejCode / touchedCR * 100) : 0,
      returnIndexQA: touchedQA ? mRound(rejQA / touchedQA * 100) : 0,
      cards: rejCards,
      rework: rejCards.filter(c => c.total >= 2),
    },
    blocked, stalled,
    focus: { waitingRelease, dueSoon, unassigned, highPriority },
    burndown: { labels, ideal, actual, vsIdeal, unit: 'SP restantes' },
  };
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

    if (url.pathname === '/metrics') {
      const cacheM = caches.default;
      const keyM = new Request(url.toString(), request);
      const hitM = await cacheM.match(keyM);
      if (hitM) return hitM;
      try {
        const payload = await buildPayload(env, parseSprintIds(url));
        const body = JSON.stringify(buildMetrics(payload));
        const res = new Response(body, { status: 200, headers: { ...headers, 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
        ctx.waitUntil(cacheM.put(keyM, res.clone()));
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
