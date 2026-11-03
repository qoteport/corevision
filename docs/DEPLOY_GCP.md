# Deploying Core Vision to Google Cloud

```
Browser ──► (optional IAP) ──► Cloud Run: corevision container
                                   │  React app + FastAPI + app login + background AI jobs
                         Secret Manager ─────────────────┤  DATABASE_URL, ANTHROPIC_API_KEY
                         Cloud SQL for PostgreSQL ◄──────┤  unix socket /cloudsql/…
                         Cloud Storage (private) ◄───────┘  core photos
```

Each deployment serves **one organization**: its own database, photos and user accounts.
The same image runs locally: with no `DATABASE_URL` it uses SQLite, and with no `CV_GCS_BUCKET` it stores photos
on disk.

## What you need

- A Google Cloud project with billing enabled, and permission to create the resources below (Owner or Editor).
- `gcloud` (already in [Cloud Shell](https://shell.cloud.google.com), the easiest place to run the scripts).
- An Anthropic API key.

## 1. One-time setup

```bash
cp deploy/gcp/config.env.example deploy/gcp/config.env   # set PROJECT_ID, REGION, BUCKET
bash deploy/gcp/setup.sh
```

`setup.sh` is safe to re-run. It:

| Creates | Notes |
|---|---|
| APIs | Cloud Run, Cloud SQL Admin, Artifact Registry, Cloud Build, Secret Manager, Storage, IAP |
| Artifact Registry repo | Docker images |
| Cloud SQL Postgres 17 | Daily backups at 03:00, storage auto-grow, deletion protection. Database and user `corevision` with a random 48-character password |
| Secrets | `corevision-database-url` (built from that password; never printed), `corevision-anthropic-key` (read from `$ANTHROPIC_API_KEY`, or prompted with hidden input) and `corevision-setup-token` (printed once, for the first-run screen) |
| Photo bucket | Uniform access, public access prevention on |
| Service account `corevision-run` | Only `cloudsql.client`, `storage.objectAdmin` on the bucket, and access to the two secrets |

## 2. Deploy (and redeploy)

```bash
bash deploy/gcp/deploy.sh
```

This builds the image with Cloud Build and deploys it to Cloud Run. Database migrations run when the container
starts; a Postgres advisory lock makes sure only one instance migrates at a time. It prints the service URL.

## 3. First sign-in

Open the URL. A new deployment shows **Set up your organization**: enter the organization name, your name,
email, a password (10+ characters) and the setup token from `setup.sh`
(`gcloud secrets versions access latest --secret corevision-setup-token` shows it again). You become the
first admin. The setup screen never appears again.

Then, under your name → **Users & organization**, add colleagues. Each gets a temporary password you pass on;
they change it after signing in. Roles:

| Role | Can |
|---|---|
| admin | everything, including users, the organization name and deleting projects |
| geologist | log, annotate, import, run AI analysis, edit holes and logs |
| viewer | read and export only |

Disabling someone, changing their role or resetting their password signs them out everywhere immediately.

### Optional: Google sign-in in front (IAP)

If everyone in the organization has a Google Workspace account, set `IAP=1` and `IAP_MEMBERS` in
`config.env` and redeploy. Google then checks identity before the app's own login. To add someone later:

```bash
gcloud beta iap web add-iam-policy-binding --resource-type=cloud-run --service=corevision \
  --region=REGION --member=user:colleague@example.com --role=roles/iap.httpsResourceAccessor
```

## 4. Continuous deployment (optional)

`cloudbuild.yaml` builds, pushes and deploys on each push. Create a Cloud Build trigger on your repository,
set the `_REGION`, `_BUCKET` and other substitutions to match `config.env`, and give the Cloud Build service
account `roles/run.admin` and `roles/iam.serviceAccountUser` on `corevision-run`.

## Settings that matter

| Setting | Why |
|---|---|
| `--no-cpu-throttling` | AI analysis runs after the upload request returns. With request-based billing Cloud Run would freeze the CPU and stall it. This uses instance-based billing |
| `--min-instances 0` | Scales to zero when idle. Set 1 to avoid cold starts (costs more) |
| `--max-instances 4`, `CV_DB_POOL_SIZE=5` | At most 20 database connections, well inside the `db-g1-small` limit. Raise both with a bigger SQL tier |
| `--concurrency 40`, `--memory 1Gi` | Room for image resizing and the 3D model endpoint |
| App login + setup token | Every API call needs a session. Sessions are HttpOnly cookies (Secure on HTTPS), 14 days sliding; passwords are scrypt-hashed; sign-in is rate-limited |

If an instance stops while a photo is being analysed, the job is marked failed after 20 minutes. Press
**Re-analyze** to run it again.

## Costs (rough)

You pay for Cloud SQL around the clock (the largest fixed cost; `db-g1-small` is the cheapest tier
recommended), Cloud Run while instances are up, Cloud Storage for the photos, and Claude API calls per photo.
Stop the SQL instance in the console when not in use, or use a smaller tier for trials.

## Operations

- **Logs:** Cloud Run → corevision → Logs.
- **Backups:** Cloud SQL takes daily backups. Photos are in the bucket; turn on object versioning if you want
  undelete.
- **Rotate the API key:** `printf '%s' NEW_KEY | gcloud secrets versions add corevision-anthropic-key --data-file=-`,
  then redeploy.
- **Migrations by hand:** `cloud-sql-proxy PROJECT:REGION:corevision-db &` then, from `backend/`,
  `DATABASE_URL=postgresql://corevision:PASSWORD@localhost:5432/corevision ../.venv/Scripts/alembic upgrade head`.

## Moving your local data

The GCP database starts empty. Re-import collars, surveys and assays from the CSV exports, and re-upload the
photos. A one-off SQLite → Postgres copy script can be added if you need to carry over annotations and edit
history.
