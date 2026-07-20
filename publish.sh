#!/usr/bin/env bash
# Publica o dashboard OE no GitHub + GitHub Pages com o mínimo de passos.
# Pré-requisitos: git e GitHub CLI (gh) autenticado  ->  gh auth login
#
# Uso:
#   ./publish.sh                # cria Lousada-Shippify/shippify-oe-dashboard (privado)
#   REPO=meu-nome ./publish.sh  # nome de repo customizado
set -euo pipefail

OWNER="${OWNER:-Lousada-Shippify}"
REPO="${REPO:-shippify-oe-dashboard}"
VIS="${VIS:-public}"     # private | public

echo "==> Repositório: $OWNER/$REPO ($VIS)"

# 1) Git local
git init -q
git add .
git commit -qm "OE dashboard — site estático (Jira via Action + snapshot pessoal)" || true
git branch -M main

# 2) Criar repo remoto + push (precisa de gh autenticado)
if command -v gh >/dev/null 2>&1; then
  gh repo create "$OWNER/$REPO" --"$VIS" --source=. --remote=origin --push

  echo "==> Configurando secrets do Jira (deixe em branco p/ pular e configurar depois)"
  read -rp "JIRA_BASE_URL [https://shippify.atlassian.net]: " JBASE
  JBASE="${JBASE:-https://shippify.atlassian.net}"
  read -rp "JIRA_EMAIL: " JEMAIL
  read -rsp "JIRA_API_TOKEN: " JTOKEN; echo
  if [ -n "$JEMAIL" ] && [ -n "$JTOKEN" ]; then
    gh secret set JIRA_BASE_URL  --repo "$OWNER/$REPO" --body "$JBASE"
    gh secret set JIRA_EMAIL     --repo "$OWNER/$REPO" --body "$JEMAIL"
    gh secret set JIRA_API_TOKEN --repo "$OWNER/$REPO" --body "$JTOKEN"
    echo "==> Secrets configurados."
  fi

  echo "==> Ativando GitHub Pages (branch main, raiz)"
  gh api --method POST "repos/$OWNER/$REPO/pages" \
    -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1 || \
    echo "   (Se falhar, ative manualmente em Settings > Pages > Branch: main / root)"

  echo "==> Rodando o workflow para gerar o data.json do Jira"
  gh workflow run update-data.yml --repo "$OWNER/$REPO" >/dev/null 2>&1 || true

  echo ""
  echo "PRONTO. Em ~1-2 min o site estará em:"
  echo "   https://${OWNER,,}.github.io/$REPO/"
else
  echo "gh (GitHub CLI) não encontrado."
  echo "Opção A: instale o gh (https://cli.github.com), rode 'gh auth login' e execute ./publish.sh de novo."
  echo "Opção B (manual): crie o repo $OWNER/$REPO no GitHub e rode:"
  echo "   git remote add origin https://github.com/$OWNER/$REPO.git"
  echo "   git push -u origin main"
  echo "Depois: Settings > Secrets and variables > Actions (adicione JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)"
  echo "        Settings > Pages > Branch: main / root"
fi
