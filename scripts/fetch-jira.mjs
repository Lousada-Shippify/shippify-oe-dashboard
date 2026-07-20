// Atualiza a parte "jira" do data.json consultando a API REST do Jira.
// Rodado pelo GitHub Action. Preserva o snapshot pessoal (calendar/emails/slack).
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
      out.push({ key: issue.key, fields: issue.fields });
    }
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return out;
}

async function main() {
  const active = await searchAll(JQL_ACTIVE, ACTIVE_FIELDS);
  const done   = await searchAll(JQL_DONE, DONE_FIELDS);

  let existing = {};
  try { existing = JSON.parse(fs.readFileSync('data.json', 'utf8')); } catch {}

  const merged = {
    ...existing,
    jira: { active, done },
    jiraGeneratedAt: new Date().toISOString(),
  };

  fs.writeFileSync('data.json', JSON.stringify(merged, null, 2));
  console.log(`data.json atualizado: ${active.length} ativas, ${done.length} concluídas.`);
}

main().catch(err => { console.error(err); process.exit(1); });
