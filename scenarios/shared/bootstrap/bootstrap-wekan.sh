#!/usr/bin/env bash
# Create the Wekan users (admin + alice + bob) and obtain a login token.
# Prints "TOKEN USER_ID" (of the admin) on stdout.
#
# Wekan's REST POST /users/register is unusable in v9.x: the bundled
# useraccounts package unconditionally sets forbidClientAccountCreation=true
# on the server (signup normally runs through a Meteor DDP method), so the
# REST route always answers 403. Users are therefore inserted directly into
# MongoDB, using the bcrypt + mongodb modules shipped inside the Wekan image
# (Meteor password = bcrypt of the sha256-hex of the password).
#
# Required env: WEKAN_URL + fixtures.env vars. Must run in the scenario dir.
# Optional env: SERVICE (compose service name, default wekan).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

: "${WEKAN_URL:?}" "${ADMIN_USER:?}" "${ADMIN_PASS:?}" "${ADMIN_EMAIL:?}"
SERVICE=${SERVICE:-wekan}

SEED_USERS=$(jq -n \
  --arg au "$ADMIN_USER" --arg ae "$ADMIN_EMAIL" --arg ap "$ADMIN_PASS" \
  --arg lu "$ALICE_USER" --arg le "$ALICE_EMAIL" --arg lp "$ALICE_PASS" \
  --arg bu "$BOB_USER" --arg be "$BOB_EMAIL" --arg bp "$BOB_PASS" \
  '[{username: $au, email: $ae, password: $ap, isAdmin: true},
    {username: $lu, email: $le, password: $lp},
    {username: $bu, email: $be, password: $bp}]')

docker compose exec -T -e SEED_USERS="$SEED_USERS" "$SERVICE" node -e '
const bcrypt = require("/build/programs/server/npm/node_modules/meteor/accounts-password/node_modules/bcrypt");
const { MongoClient } = require("/build/programs/server/npm/node_modules/meteor/npm-mongo/node_modules/mongodb");
const crypto = require("crypto");
(async () => {
  const client = await MongoClient.connect(process.env.MONGO_URL);
  const db = client.db();
  for (const u of JSON.parse(process.env.SEED_USERS)) {
    if (await db.collection("users").findOne({ username: u.username })) { console.log(u.username + " exists"); continue; }
    const sha = crypto.createHash("sha256").update(u.password).digest("hex");
    await db.collection("users").insertOne({
      _id: crypto.randomBytes(13).toString("base64").replace(/[+/=]/g, "").slice(0, 17),
      createdAt: new Date(), username: u.username,
      emails: [{ address: u.email, verified: true }],
      services: { password: { bcrypt: await bcrypt.hash(sha, 10) } },
      isAdmin: !!u.isAdmin, authenticationMethod: "password", sessionData: {},
    });
    console.log("created " + u.username);
  }
  await client.close();
})().catch(e => { console.error(e); process.exit(1); });' >&2

LOGIN=$(curl -fsS -X POST "$WEKAN_URL/users/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "$ADMIN_USER" --arg p "$ADMIN_PASS" '{username: $u, password: $p}')")
log "wekan admin $ADMIN_USER ready"
printf '%s %s\n' "$(jq -re .token <<<"$LOGIN")" "$(jq -re .id <<<"$LOGIN")"
