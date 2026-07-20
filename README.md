# Dashboard OE — Operation Experience

Site estático (GitHub Pages) no mesmo modelo do `shippify-weekly-squads-team`:
o **Jira** é atualizado automaticamente por um **GitHub Action** que regrava o `data.json`;
**Agenda, Gmail e Slack** entram como *snapshot* (foto do momento da geração), pois são
dados pessoais e não podem ser buscados por um Action público sem expor seus tokens.

## O que atualiza sozinho

| Fonte | Atualização | Como |
|------|-------------|------|
| Jira (sprint board, progresso/burndown, produtividade) | a cada 15 min | GitHub Action → API REST do Jira |
| Agenda / Gmail / Slack | snapshot fixo | embutido no `data.json` no momento da geração |

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
├── index.html                  # dashboard (lê ./data.json)
├── data.json                   # dados: jira (Action) + snapshot pessoal
├── scripts/fetch-jira.mjs      # consulta o Jira e regrava data.json
├── .github/workflows/update-data.yml
├── publish.sh                  # publicação em 1 comando
└── README.md
```
