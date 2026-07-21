# Dashboard OE — Operation Experience

Site estático (GitHub Pages) no mesmo modelo do `shippify-weekly-squads-team`:
o **Jira** é atualizado automaticamente por um **GitHub Action** que regrava o `data.json`;
**Agenda, Gmail e Slack** entram como *snapshot* (foto do momento da geração), pois são
dados pessoais e não podem ser buscados por um Action público sem expor seus tokens.

## O que atualiza sozinho

| Fonte | Atualização | Como |
|------|-------------|------|
| Jira (sprint board, progresso/burndown, produtividade) | a cada 5 min (fundo) + **ao vivo no clique de "Atualizar"** | GitHub Action → API REST do Jira, com fallback ao vivo via Cloudflare Worker |
| Agenda / Gmail / Slack | snapshot fixo | embutido no `data.json` no momento da geração |

### Botão "Atualizar" — Jira ao vivo (Cloudflare Worker)

O botão tenta primeiro um proxy Cloudflare Worker (`worker/`), que guarda o token do Jira
como segredo (nunca aparece no site) e responde com dados frescos direto do Jira. Se o
Worker não estiver publicado ou estiver fora do ar, o botão cai automaticamente para o
`data.json` (snapshot do GitHub Action, no máximo 5 min desatualizado).

Publicar o Worker (uma vez):

```bash
cd oe-dashboard-site/worker
./deploy-worker.sh
```

O script abre o navegador para você logar/criar uma conta Cloudflare grátis, pede os 3
segredos do Jira em prompts ocultos, publica o Worker e já atualiza o `index.html` com a
URL gerada. Depois é só `git add -A && git commit -m "..." && git push`.

Sem publicar o Worker, o dashboard continua funcionando normalmente — só que o botão
"Atualizar" recarrega o último snapshot em vez de consultar o Jira na hora.

## Publicar (mínimo de passos)

**Caminho rápido** — com o [GitHub CLI](https://cli.github.com) autenticado (`gh auth login`):

```bash
cd oe-dashboard-site
./publish.sh
```

O script cria o repositório `Lousada-Shippify/shippify-oe-dashboard` (privado), sobe os
arquivos, pergunta os 3 secrets do Jira, ativa o Pages e dispara o workflow. Em ~2 min o
site fica no ar.

**Caminho manual** (sem gh):

1. Crie um repositório vazio no GitHub (ex.: `shippify-oe-dashboard`).
2. Nesta pasta:
   ```bash
   git init && git add . && git commit -m "OE dashboard" && git branch -M main
   git remote add origin https://github.com/Lousada-Shippify/shippify-oe-dashboard.git
   git push -u origin main
   ```
3. **Settings → Secrets and variables → Actions** → adicione:
   - `JIRA_BASE_URL` = `https://shippify.atlassian.net`
   - `JIRA_EMAIL` = seu e-mail Atlassian
   - `JIRA_API_TOKEN` = token de https://id.atlassian.com/manage-profile/security/api-tokens
4. **Settings → Pages** → Branch `main`, pasta `/ (root)`.
5. **Actions → Atualizar dados do Jira → Run workflow** (gera o primeiro `data.json`).

URL final: `https://lousada-shippify.github.io/shippify-oe-dashboard/`

## Atualizar o snapshot pessoal (Agenda/Gmail/Slack)

Peça ao Claude (Cowork) para "regenerar o snapshot do dashboard OE" — ele recaptura os 3
e regrava o `data.json` (parte pessoal). Faça commit/push para publicar. O Jira segue
automático e não é afetado.

## Estrutura

```
oe-dashboard-site/
├── index.html                  # dashboard (lê ./data.json + tenta Jira ao vivo)
├── data.json                   # dados: jira (Action) + snapshot pessoal
├── scripts/fetch-jira.mjs      # consulta o Jira e regrava data.json
├── .github/workflows/update-data.yml  # roda a cada 5 min
├── worker/                     # proxy Cloudflare Worker (Jira ao vivo no clique)
│   ├── index.js
│   ├── wrangler.toml
│   └── deploy-worker.sh
├── publish.sh                  # publicação em 1 comando
└── README.md
```
