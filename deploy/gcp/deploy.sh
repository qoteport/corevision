#!/usr/bin/env bash
# Build the image with Cloud Build and deploy it to Cloud Run. Run from anywhere:  bash deploy/gcp/deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source config.env
cd ../..

gcloud config set project "$PROJECT_ID" >/dev/null
SA_EMAIL="$RUN_SA@$PROJECT_ID.iam.gserviceaccount.com"
CONN="$PROJECT_ID:$REGION:$SQL_INSTANCE"
TAG="$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d-%H%M%S)"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/corevision:$TAG"

echo "==> Building $IMAGE"
gcloud builds submit --tag "$IMAGE" .

# The app has its own login. With IAP on, Google sign-in is added in front of it.
if [ "${IAP:-0}" = "1" ]; then AUTH=(--no-allow-unauthenticated --iap); else AUTH=(--allow-unauthenticated); fi

echo "==> Deploying $SERVICE"
# --no-cpu-throttling (instance-based billing) keeps CPU on after a response, which the background
# AI analysis needs. --timeout covers slow uploads; analysis itself runs after the request returns.
gcloud run deploy "$SERVICE" --image "$IMAGE" --region "$REGION" \
  --service-account "$SA_EMAIL" \
  --add-cloudsql-instances "$CONN" \
  --set-secrets "DATABASE_URL=corevision-database-url:latest,ANTHROPIC_API_KEY=corevision-anthropic-key:latest,CV_SETUP_TOKEN=corevision-setup-token:latest" \
  --set-env-vars "CV_GCS_BUCKET=$BUCKET,CV_DB_POOL_SIZE=5" \
  --cpu 1 --memory 1Gi --concurrency 40 --timeout 900 --no-cpu-throttling \
  --min-instances "$MIN_INSTANCES" --max-instances "$MAX_INSTANCES" \
  "${AUTH[@]}"

if [ "${IAP:-0}" = "1" ]; then
  echo "==> Identity-Aware Proxy access"
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
  # IAP's service agent must be allowed to invoke the service on behalf of signed-in users.
  gcloud run services add-iam-policy-binding "$SERVICE" --region "$REGION" \
    --member "serviceAccount:service-$PROJECT_NUMBER@gcp-sa-iap.iam.gserviceaccount.com" \
    --role roles/run.invoker >/dev/null
  IFS=',' read -ra MEMBERS <<< "$IAP_MEMBERS"
  for m in "${MEMBERS[@]}"; do
    gcloud beta iap web add-iam-policy-binding --resource-type cloud-run --service "$SERVICE" \
      --region "$REGION" --member "$m" --role roles/iap.httpsResourceAccessor >/dev/null
    echo "    allowed $m"
  done
fi

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
echo
echo "Deployed: $URL"
echo "First visit: create the organization and admin account (needs the setup token from setup.sh)."
echo "Show it again with: gcloud secrets versions access latest --secret corevision-setup-token"
