#!/usr/bin/env bash
# Publica o proxy Cloudflare Worker que dá vida ao botão "Atualizar" do dashboard.
# Rode este script de dentro da pasta oe-dashboard-site/worker.
#
# O que ele faz:
#   1) Garante que o wrangler (CLI da Cloudflare) está disponível (via npx, sem instalar global).
#   2) Abre o navegador para você logar/criar sua conta Cloudflare (grátis).
#   3) Pede os 3 segredos do Jira em prompts OCULTOS (nunca aparecem na tela).
#   4) Publica o Worker e captura a URL pública gerada.
#   5) Atualiza o index.html (na pasta pai) trocando o placeholder pela URL real.
#
# Depois disso, basta commitar e dar push (o script já te mostra os comandos).
set -euo pipefail

echo "==> 1) Login na Cloudflare (abre o navegador)…"
npx --yes wrangler login

echo ""
echo "==> 2) Segredos do Jira — cada um vai pedir 'Enter secret value' de forma OCULTA."
echo "    JIRA_BASE_URL (ex.: https://shippify.atlassian.net):"
npx --yes wrangler secret put JIRA_BASE_URL
echo "    JIRA_EMAIL (seu e-mail Atlassian):"
npx --yes wrangler secret put JIRA_EMAIL
echo "    JIRA_API_TOKEN (gerado em id.atlassian.com/manage-profile/security/api-tokens):"
npx --yes wrangler secret put JIRA_API_TOKEN

echo ""
echo "==> 3) Publicando o Worker…"
DEPLOY_OUT="$(npx --yes wrangler deploy)"
echo "$DEPLOY_OUT"

WORKER_URL="$(echo "$DEPLOY_OUT" | grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)"

if [ -z "$WORKER_URL" ]; then
  echo ""
  echo "!! Não consegui detectar a URL automaticamente no log acima."
  echo "   Copie a URL que aparece depois de 'Published oe-dashboard-jira' (termina em .workers.dev)"
  echo "   e rode manualmente:"
  echo '   sed -i "" "s#https://REPLACE-ME.workers.dev#SUA_URL_AQUI#" ../index.html'
  exit 0
fi

echo ""
echo "==> 4) Worker publicado em: $WORKER_URL"
echo "    Atualizando index.html…"
sed -i '' "s#https://REPLACE-ME.workers.dev#${WORKER_URL}#" ../index.html

echo ""
echo "==> Pronto! Agora suba a mudança:"
echo "    cd .."
echo "    rm -f .git/index.lock"
echo "    git add -A && git commit -m \"Botao Atualizar: consulta Jira ao vivo via Cloudflare Worker\" && git pull --rebase && git push"
