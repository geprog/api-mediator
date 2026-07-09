#!/usr/bin/env bash
# Bootstrap the scenario-5 landscape (idempotent): OrangeHRM headless install,
# Dolibarr admin API key, Kimai API token. Writes tokens to .tokens.env.
# Run after: docker compose up -d --wait
set -euo pipefail
cd "$(dirname "$0")"
source ../shared/lib.sh
set -a
source ../shared/fixtures.env
source .env
set +a

TOKENS_FILE=.tokens.env

wait_for_http "http://localhost:${DOLIBARR_PORT}/" 300 # first boot runs the auto-installer
wait_for_http "http://localhost:${KIMAI_PORT}/"
wait_for_http "http://localhost:${ORANGEHRM_PORT}/"

# --- Dolibarr: admin API key (DOLAPIKEY header) -----------------------------
# The REST module is enabled at install (DOLI_ENABLE_MODULES); the key itself
# lives on the user row and is simplest to set directly.
DOLIBARR_API_KEY="mediator$(openssl rand -hex 12)"
docker compose exec -T dolibarr-db mariadb -udolibarr -pdolibarr-pass dolibarr \
  -e "UPDATE llx_user SET api_key='$DOLIBARR_API_KEY' WHERE login='$ADMIN_USER';"
curl -fsS -o /dev/null -H "DOLAPIKEY: $DOLIBARR_API_KEY" \
  "http://localhost:${DOLIBARR_PORT}/api/index.php/status" || die "dolibarr API not answering"
save_token "$TOKENS_FILE" DOLIBARR_API_KEY "$DOLIBARR_API_KEY"

# --- Kimai: API token --------------------------------------------------------
# No console command and no REST endpoint mints tokens; the token column is
# plaintext, so inserting one is the scriptable path. The ADMINPASS env made
# user "admin" (id 1) at first boot.
KIMAI_TOKEN="tk_$(openssl rand -hex 20)"
docker compose exec -T kimai-db mariadb -ukimai -pkimai-pass kimai -e \
  "DELETE FROM kimai2_access_token WHERE name='mediator';
   INSERT INTO kimai2_access_token (user_id, token, name) VALUES (1, '$KIMAI_TOKEN', 'mediator');"
curl -fsS -o /dev/null -H "Authorization: Bearer $KIMAI_TOKEN" \
  "http://localhost:${KIMAI_PORT}/api/version" || die "kimai API not answering"
save_token "$TOKENS_FILE" KIMAI_TOKEN "$KIMAI_TOKEN"

# --- OrangeHRM: headless install (web installer never needed) ---------------
# API v2 uses the session (as the web UI does); scripts log in per run, so no
# token is saved. A future mediator needs an OAuth2 client (Admin > OAuth).
if docker compose exec -T orangehrm sh -c 'php -r "
    require \"/var/www/html/src/vendor/autoload.php\";
    exit(OrangeHRM\Config\Config::isInstalled() ? 0 : 1);"'; then
  log "orangehrm already installed"
else
  log "installing orangehrm via CLI installer"
  docker compose exec -T orangehrm sh -c "cat > /var/www/html/installer/cli_install_config.yaml" <<EOF
database:
  hostName: orangehrm-db
  hostPort: 3306
  databaseName: orangehrm
  privilegedDatabaseUser: root
  privilegedDatabasePassword: root-pass
  useSameDbUserForOrangeHRM: y
  orangehrmDatabaseUser: ~
  orangehrmDatabasePassword: ~
  isExistingDatabase: y # the mariadb sidecar pre-creates the (empty) database
  enableDataEncryption: n
organization:
  name: Mediator Test Landscape
  country: DE
admin:
  adminUserName: $ADMIN_USER
  adminPassword: $ADMIN_PASS_STRICT
  adminEmployeeFirstName: Mediator
  adminEmployeeLastName: Admin
  workEmail: $ADMIN_EMAIL
  contactNumber: ~
  registrationConsent: false
license:
  agree: y
EOF
  docker compose exec -T orangehrm php /var/www/html/installer/cli_install.php >&2
fi

log "bootstrap done — tokens in $TOKENS_FILE"
