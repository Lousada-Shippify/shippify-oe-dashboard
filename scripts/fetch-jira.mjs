// Atualiza a parte "jira" do data.json consultando a API REST do Jira.
// Rodado pelo GitHub Action. Preserva o snapshot pessoal (calendar/emails/slack).
// Também calcula, por issue, o nº de rejeições (código e QA) a partir do CHANGELOG,
// para o indicador de qualidade/performance do dashboard.
//
// Secrets necessários no repositório:
//   JIRA_BASE_URL   ex.: https://shippify.atlassian.net
//   JIRA_EMAIL      seu e-mail Atlassian
//   JIRA_API_TOKEN  token em https://id.atlassian.com/manage-profile/security/api-tokens
//
// Node 20+ (fetch nativo). Uso: node scripts/fetch-jira.mjs

import fs from 'fs';

const BASE  = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
const EMAIL = process.env.JIRA_EMAIL || '';
const TOKEN = process.env.JIRA_API_TOKEN || '';

if (!BASE || !EMAIL || !TOKEN) {
  console.error('Faltam secrets: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

const ACTIVE_FIELDS = ['summary','status','assignee','issuetype','priority','duedate','customfield_10020','customfield_10028','customfield_10546','parent'];
const DONE_FIELDS   = ['summary','status','assignee','issuetype','priority','customfield_10020','customfield_10028','customfield_10546','resolutiondate','updated','parent'];

const JQL_ACTIVE = 'sprint in openSprints() AND project = "OE" AND statusCategory != Done ORDER BY priority ASC, updated DESC';
const JQL_DONE   = 'sprint in openSprints() AND project = "OE" AND statusCategory = Done ORDER BY resolutiondate ASC';

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

async function searchAll(jql, fields) {
  const out = [];
  let nextPageToken = undefined;
  for (let i = 0; i < 20; i++) {
    const body = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Authorization': AUTH, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Jira ${res.status}: ${t.slice(0, 500)}`);
    }
    const data = await res.json();
    for (const issue of (data.issues || [])) {
      out.push({ id: issue.id, key: issue.key, fields: issue.fields });
    }
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return out;
}

// Conta transições PARA status de rejeição (código/QA) por issue, via changelog em lote.
async function fetchRejections(issueIds) {
  const rej = {};
  for (const id of issueIds) rej[id] = { code: 0, qa: 0, tQA: false, tCR: false };
  if (!issueIds.length) return rej;
  let nextPageToken;
  for (let page = 0; page < 40; page++) {
    const body = { issueIdsOrKeys: issueIds, fieldIds: ['status'], maxResults: 1000 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await fetch(`${BASE}/rest/api/3/changelog/bulkfetch`, {
      method: 'POST',
      headers: { 'Authorization': AUTH, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.warn(`changelog bulkfetch ${res.status} — rejeições ficam zeradas`); break; }
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

async function main() {
  const active = await searchAll(JQL_ACTIVE, ACTIVE_FIELDS);
  const done   = await searchAll(JQL_DONE, DONE_FIELDS);

  const ids = [...active, ...done].map(i => i.id).filter(Boolean);
  let rej = {};
  try { rej = await fetchRejections(ids); } catch (e) { console.warn('rejeições:', e.message); }
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

  let existing = {};
  try { existing = JSON.parse(fs.readFileSync('data.json', 'utf8')); } catch {}

  const merged = {
    ...existing,
    jira: { active, done },
    jiraGeneratedAt: new Date().toISOString(),
  };

  fs.writeFileSync('data.json', JSON.stringify(merged, null, 2));
  const totRej = [...active, ...done].reduce((s,i)=>s+i._rejCode+i._rejQA,0);
  console.log(`data.json atualizado: ${active.length} ativas, ${done.length} concluídas, ${totRej} rejeições.`);
}

main().catch(err => { console.error(err); process.exit(1); });
