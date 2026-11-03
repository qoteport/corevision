# Core Vision

AI-assisted drill-core logging and 3D drillhole modelling. Upload core photos hole by hole, let Claude pre-log
them (lithology, alteration, mineralization, veins, structure), correct the result in a polygon editor, then
view every hole in 3D with desurveyed paths, a drilling simulation and cross-hole correlation.

This is the Phase 1 MVP from [docs/PRODUCT.md](docs/PRODUCT.md), built from the single-file demo in
[docs/core-vision-studio-demo.html](docs/core-vision-studio-demo.html).

## Run it

Needs Python 3.11+ and Node 20+.

**One step:** double-click `run.bat` (Windows) or run `./run.sh` (macOS/Linux). On first run it creates the
Python environment, installs packages, copies `.env.example` to `.env`, then builds the frontend and starts
the server at http://localhost:8000.

**By hand:**

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # macOS/Linux: .venv/bin/pip
cp .env.example .env                              # then put your ANTHROPIC_API_KEY in .env
npm --prefix frontend install
npm --prefix frontend run build                   # writes frontend/dist, served by FastAPI
.venv/Scripts/python -m uvicorn app.main:app --app-dir backend --port 8000
```

**Frontend development** (hot reload): keep the server above running, then `npm --prefix frontend run dev`
and open http://localhost:5173. Vite proxies `/api` to port 8000.

Without an API key the app still works for manual logging. AI analysis is off and a banner says so.

Tests: `.venv/Scripts/pip install -r requirements-dev.txt`, then `.venv/Scripts/python -m pytest -q tests` ·
frontend typecheck: `npm --prefix frontend run typecheck`

## Docker

One image holds the built React app and the FastAPI server. The SQLite database and uploaded photos live in
`/data`, which must be a persistent volume; migrations run on start.

```bash
docker compose up --build          # http://localhost:8000, data kept in the "corevision-data" volume
```

Or without compose:

```bash
docker build -t corevision .
docker run -p 8000:8000 -v corevision-data:/data --env-file .env corevision
```

The container listens on `$PORT` (default 8000), so it runs as-is on container hosts that provide a persistent
disk: Railway (add a volume at `/data`), Render (add a disk at `/data`), Fly.io (`fly volumes create` and mount
at `/data`), or any VPS with Docker. Set `ANTHROPIC_API_KEY` as a secret in the host's settings, never in the
image. Back up the volume: it is the whole database.

**Google Cloud:** Cloud Run + Cloud SQL (Postgres) + Cloud Storage, with Google sign-in through IAP. Two
scripts set it up and deploy it; see [docs/DEPLOY_GCP.md](docs/DEPLOY_GCP.md). The backend uses Postgres when
`DATABASE_URL` is set and a Cloud Storage bucket when `CV_GCS_BUCKET` is set; otherwise SQLite and local disk.
`docker compose up` runs the app with a Postgres container, the same way.

**Vercel is not a fit for this image.** Vercel does not run Docker containers, its functions have no persistent
disk (SQLite and photos would vanish), and work after the response, like the background AI analysis, is cut
off. Running on Vercel needs hosted Postgres, blob storage for photos and a job queue for analysis.

## What it does

| Area | Behaviour |
|---|---|
| Projects | Name, deposit style (adds deposit-specific guidance to the AI prompt), CRS EPSG code |
| Holes | Collar E/N/RL, azimuth, dip (degrees below horizontal), length; edit or delete |
| Import | Collar CSV (`hole, easting, northing, rl, azimuth, dip, length[, core_size]`), survey CSV (`hole, depth, azimuth, dip`), assay CSV (`hole, from, to[, sample_id]` + one column per element such as `Au_ppm`, `Cu_pct`, `Zn`; `<0.01` and negative lab codes are stored at half the detection limit) |
| Surveys | Per-hole survey stations, desurveyed with **minimum curvature**; straight line from the collar when none |
| Upload | One photo at a time with core run from/to and the direction depth increases; resized to 1568 px |
| AI logging | Claude vision runs as a background job. Output is constrained to a JSON schema (`output_config.format`) and validated with pydantic, so there is no regex parsing. Returns core boxes, KPIs, minerals, lithology and polygons/polylines |
| Trust | Re-analyze replaces only unverified AI features; features you draw or mark verified are kept. Every edit is written to an `edit_event` audit table |
| Editor | Select, drag shape or points, add/delete points, grow/shrink, relabel, change category, confidence, verified flag, freehand draw, undo/redo, keyboard shortcuts |
| Depth | Each feature and break gets a depth by walking the tray **row by row** (row 1 start → end, then row 2 …) across the core run |
| Interval log | Continuous from–to log per hole: lithology, alteration + intensity (0–3), mineralization, sulphide %, vein %, comments. **Draft from photos** builds a first pass from the annotations (lithology carried through, slivers < 0.2 m folded in); QA flags gaps, unlogged photographed core and runs past end of hole |
| Logging codes | Per-project dictionary (lithology, alteration, mineralization) with a standard starter set. The AI labels with these codes and the log suggests them |
| Assays | Per-hole assay tables, grade column on the strip log, 3D colouring by grade |
| Intercepts | Length-weighted composites with cut-off, maximum internal dilution, minimum length and an "incl." higher cut-off, written as `20.0 m @ 0.97 % Cu from 56.0 m, incl. …`. Unsampled gaps count as zero grade; lengths are downhole |
| Calibration | Visual sulphide % (interval log, else AI photo estimate) against assay for each sample, with the correlation coefficient |
| Geotech | Core size per hole (BQ–PQ3). Core rows (AI or drawn) and breaks (AI or clicked; natural vs drilling/handling). Per run: **RQD** (pieces ≥ 10 cm between natural fractures), **recovery** and **fracture frequency**, scaled from the core diameter in the photo or a manual px/mm; Deere rock-quality class per hole |
| Hole page | Tabs for photos & collar & survey, interval log, assays & intercepts, geotech; strip log with log, category, grade and RQD columns |
| Overview | Project dashboard, significant intercepts across holes, visual-vs-assay chart, logging codes, settings |
| 3D | Tubes along desurveyed paths, coloured intervals, hover tooltips, drilling simulation with progressive reveal, nearest-neighbour correlation ribbons, orbit/pan/zoom; scene is re-centred so real UTM coordinates render without jitter |
| Export | Interval log (lithlog) CSV, collars, surveys, assays, geotech (RQD/recovery/FF) and photo-feature CSVs, project JSON |

## Database migrations (Alembic)

The schema lives in `backend/migrations/versions/`. The server runs `alembic upgrade head` at startup, and a
database created before Alembic was added is stamped at the baseline (`0001`) first, so no data is lost.

```bash
cd backend
../.venv/Scripts/alembic current                       # show the revision
../.venv/Scripts/alembic upgrade head                  # apply migrations by hand
../.venv/Scripts/alembic revision -m "add sample type" # new migration; edit the generated file
../.venv/Scripts/alembic downgrade -1                  # roll back one revision
```

The app uses plain `sqlite3` and migrations are written by hand (no autogenerate). Use `op.batch_alter_table`
for column changes so they work on SQLite.

## Layout

```
backend/app/
  main.py       FastAPI routes for projects, holes, images, features, model, exports; serves the frontend
  intervals.py  interval log, draft builder, QA checks, logging codes
  assays.py     assay CSV import, significant intercepts, visual-vs-assay calibration
  geotech.py    core breaks, RQD / recovery / fracture frequency per run and per hole
  ai.py         Claude prompt, JSON schema, error handling, annotation and break clean-up
  geo.py        row-by-row depth mapping, minimum-curvature desurvey, geotech maths, intercept compositing
  db.py         SQLite access and Alembic startup migration
  config.py     env settings
backend/migrations/  Alembic environment and revisions (0001 baseline, 0002 logging/assays/geotech)
frontend/     React 19 + TypeScript + Vite
  src/api.ts            typed API client
  src/store.ts          app state (zustand): project tree, routing, undo/redo, debounced feature sync, polling
  src/views/            Overview, HoleView (+ StripLog, uploader), ImageEditor, Scene3D (React Three Fiber)
  src/components/       TopBar, Sidebar, modals, toasts
docs/legacy-frontend/ the earlier plain-JS frontend, kept for reference
tests/        geometry + API tests
data/         SQLite database and stored images (created at start, git-ignored)
```

## Claude settings

- Model `claude-opus-5-5` with adaptive thinking and `effort: high` (change with `CV_MODEL` / `CV_EFFORT`).
- Server-side refusal fallback is on (`fallbacks: "default"`); set `CV_FALLBACKS=0` to turn it off.
- Forced `tool_choice` is rejected by current models, so structured output uses `output_config.format`
  rather than the forced-tool pattern sketched in PRODUCT.md §7.

## Not built yet (next phases in PRODUCT.md)

Auth and roles, Postgres/PostGIS and S3, SAM 2 masks, OCR of depth blocks, ArUco scale calibration, Batch API
bulk logging, structural alpha/beta measurements and stereonets, cross-sections and plan maps, kriging/implicit
models, GeoPackage/VTK/DXF export.

AI estimates are indicative. A qualified geologist and laboratory assays must verify them.
