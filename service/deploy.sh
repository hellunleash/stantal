#!/usr/bin/env bash
#
# Deploy the verdict host.
#
# Idempotent: every step checks before it creates, so running this twice is a
# redeploy rather than an error. Nothing here is required for the CLI to produce
# a verdict — this only exists so a verdict can be forwarded as a link.
set -euo pipefail

PROJECT="${STANTAL_GCP_PROJECT:-stantal-506811}"
REGION="${STANTAL_GCP_REGION:-us-central1}"
SERVICE="${STANTAL_SERVICE_NAME:-stantal}"
BUCKET="${STANTAL_VERDICT_BUCKET:-${PROJECT}-verdicts}"
# The public origin, for the absolute URLs in link previews. Override once a
# different domain points at this service.
SITE_URL="${STANTAL_SITE_URL:-https://stantal.cloud}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/.." && pwd)"

echo "project ${PROJECT} · region ${REGION} · service ${SERVICE} · bucket ${BUCKET}"

# 1. The renderer, from this working tree rather than the registry. Keeps the
#    hosted page byte-identical to the one `--html` writes locally.
echo "==> packing the renderer"
mkdir -p "${here}/vendor"
rm -f "${here}/vendor/"*.tgz
( cd "${repo}" && npm run build >/dev/null && npm pack --pack-destination "${here}/vendor" >/dev/null )
mv "${here}/vendor/"stantal-*.tgz "${here}/vendor/stantal.tgz"

# 1b. The landing page, exported to plain files. Built here rather than
#     committed so the page and the code that serves it can never disagree.
echo "==> building the landing page"
rm -rf "${here}/site"
# Baked in at build time: the export has no request-time anything to read it
# later. Only affects the absolute URLs in link previews, so a wrong value
# costs a bad preview card rather than a broken page.
( cd "${repo}/site" && STANTAL_SITE_URL="${SITE_URL}" npm run build >/dev/null )
cp -r "${repo}/site/out" "${here}/site"

# 2. The bucket. Uniform access, no public reads: pages are served through the
#    service, never straight off the bucket, so there is exactly one path in and
#    one way to change what it returns.
if ! gcloud storage buckets describe "gs://${BUCKET}" --project "${PROJECT}" >/dev/null 2>&1; then
  echo "==> creating gs://${BUCKET}"
  gcloud storage buckets create "gs://${BUCKET}" \
    --project "${PROJECT}" \
    --location "${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
else
  echo "==> bucket already exists"
fi

# 3. A service account of its own, holding one permission on one bucket. The
#    default compute account can reach far more of the project than a renderer
#    of HTML has any business reaching.
SA="stantal-verdict@${PROJECT}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "${SA}" --project "${PROJECT}" >/dev/null 2>&1; then
  echo "==> creating service account"
  gcloud iam service-accounts create stantal-verdict \
    --project "${PROJECT}" \
    --display-name "Stantal verdict host"
fi

echo "==> granting object access on the bucket only"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --project "${PROJECT}" \
  --member "serviceAccount:${SA}" \
  --role roles/storage.objectAdmin >/dev/null

# 4. Deploy. Scale to zero, so an idle month costs nothing.
echo "==> deploying"
gcloud run deploy "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --source "${here}" \
  --service-account "${SA}" \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 4 \
  --memory 512Mi \
  --timeout 60 \
  --set-env-vars "VERDICT_BUCKET=${BUCKET}" \
  --quiet

URL="$(gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --format 'value(status.url)')"

# The service builds its own links, so it has to be told its own address. Known
# only after the first deploy, which is why this is a second pass rather than
# part of the first.
echo "==> setting PUBLIC_ORIGIN=${URL}"
gcloud run services update "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --set-env-vars "VERDICT_BUCKET=${BUCKET},PUBLIC_ORIGIN=${URL}" \
  --quiet >/dev/null

echo
echo "deployed: ${URL}"
echo "  health: ${URL}/status"
echo "  publish: stantal <pkg> <from> <to> --publish ${URL}"
