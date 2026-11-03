#!/usr/bin/env bash
# One-time Google Cloud setup for Core Vision. Safe to re-run: existing resources are kept.
# Creates: APIs, Artifact Registry repo, Cloud SQL Postgres + database + user, a private photo bucket,
# a runtime service account with least-privilege roles, and Secret Manager secrets.
# Run from the repo root (Cloud Shell works well):  bash deploy/gcp/setup.sh
set -euo pipefail
cd "$(dirname "$0")"
[ -f config.env ] || { echo "Copy config.env.example to config.env and edit it first."; exit 1; }
# shellcheck disable=SC1091
source config.env

gcloud config set project "$PROJECT_ID" >/dev/null
SA_EMAIL="$RUN_SA@$PROJECT_ID.iam.gserviceaccount.com"
CONN="$PROJECT_ID:$REGION:$SQL_INSTANCE"
exists() { "$@" >/dev/null 2>&1; }

echo "==> Enabling APIs"
gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com storage.googleapis.com iap.googleapis.com

echo "==> Artifact Registry repository $REPO"
exists gcloud artifacts repositories describe "$REPO" --location "$REGION" ||
  gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION" \
    --description "Core Vision images"

echo "==> Cloud SQL instance $SQL_INSTANCE (this takes several minutes the first time)"
exists gcloud sql instances describe "$SQL_INSTANCE" ||
  gcloud sql instances create "$SQL_INSTANCE" --database-version POSTGRES_17 --edition ENTERPRISE \
    --tier "$SQL_TIER" --region "$REGION" --storage-auto-increase --backup-start-time 03:00 \
    --deletion-protection
exists gcloud sql databases describe corevision --instance "$SQL_INSTANCE" ||
  gcloud sql databases create corevision --instance "$SQL_INSTANCE"

echo "==> Database user and DATABASE_URL secret"
if ! exists gcloud secrets describe corevision-database-url; then
  DB_PASS="$(openssl rand -hex 24)"
  if [ -n "$(gcloud sql users list --instance "$SQL_INSTANCE" --filter "name=corevision" --format "value(name)")" ]; then
    gcloud sql users set-password corevision --instance "$SQL_INSTANCE" --password "$DB_PASS"
  else
    gcloud sql users create corevision --instance "$SQL_INSTANCE" --password "$DB_PASS"
  fi
  # Cloud Run reaches Cloud SQL over a unix socket mounted at /cloudsql/<connection name>.
  printf 'postgresql://corevision:%s@/corevision?host=/cloudsql/%s' "$DB_PASS" "$CONN" |
    gcloud secrets create corevision-database-url --replication-policy automatic --data-file=-
  unset DB_PASS
else
  echo "    secret exists, keeping it"
fi

echo "==> Anthropic API key secret"
if ! exists gcloud secrets describe corevision-anthropic-key; then
  KEY="${ANTHROPIC_API_KEY:-}"
  if [ -z "$KEY" ]; then read -rsp "    Paste your Anthropic API key (input hidden): " KEY; echo; fi
  printf '%s' "$KEY" | gcloud secrets create corevision-anthropic-key --replication-policy automatic --data-file=-
  unset KEY
else
  echo "    secret exists, keeping it (add a version to rotate: gcloud secrets versions add corevision-anthropic-key --data-file=-)"
fi

echo "==> Photo bucket gs://$BUCKET (private)"
exists gcloud storage buckets describe "gs://$BUCKET" ||
  gcloud storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access \
    --public-access-prevention

echo "==> Runtime service account $SA_EMAIL"
exists gcloud iam service-accounts describe "$SA_EMAIL" ||
  gcloud iam service-accounts create "$RUN_SA" --display-name "Core Vision (Cloud Run)"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA_EMAIL" \
  --role roles/cloudsql.client --condition None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA_EMAIL" \
  --role roles/storage.objectAdmin >/dev/null
for s in corevision-database-url corevision-anthropic-key; do
  gcloud secrets add-iam-policy-binding "$s" --member "serviceAccount:$SA_EMAIL" \
    --role roles/secretmanager.secretAccessor >/dev/null
done

echo
echo "Setup done. Next: bash deploy/gcp/deploy.sh"
