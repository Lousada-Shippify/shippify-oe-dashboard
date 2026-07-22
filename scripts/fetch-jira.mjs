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

// Classifica um nome de status como rejeição de código, de QA, ou nenhum.
function rejKind(statusName) {
  const s = (statusName || '').toLowerCase();
  if (!s.includes('reject') && !s.includes('denied') && !s.includes('rejeit')) return null;
  return s.includes('qa') ? 'qa' : 'code';
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
  for (const id of issueIds) rej[id] = { code: 0, qa: 0 };
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
      if (!rej[id]) rej[id] = { code: 0, qa: 0 };
      for (const h of (entry.changeHistories || [])) {
        for (const item of (h.items || [])) {
          if (item.field !== 'status' && item.fieldId !== 'status') continue;
          const kind = rejKind(item.toString);
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
  const attach = i => { const r = rej[i.id] || { code: 0, qa: 0 }; i._rejCode = r.code; i._rejQA = r.qa; return i; };
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
