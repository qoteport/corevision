# Core Vision: AI drill-core logging and 3D geological modelling

A product for exploration geologists: upload core photos hole by hole, get AI-assisted visual logging (lithology, alteration, mineralization, structure), correct it in a polygon editor, then see all holes together in 3D with depth, hole orientation, drilling simulation and cross-hole correlation.

This README describes (1) what the demo already does, (2) how to build the production version with Claude and open-source geo packages, and (3) a roadmap.

---

## 1. What the demo does (`core-vision-studio.html`)

| Area | Demo behaviour |
|---|---|
| Projects | Create projects, stored in the browser (IndexedDB) |
| Holes | Name, collar E/N/RL, azimuth, dip (degrees below horizontal), length |
| Upload | One photo at a time with hole, depth from/to, depth direction along the image, deposit style |
| AI logging | Claude vision returns core location, KPIs, minerals, lithology and curved polygons/polylines per feature |
| Editor | Select, drag shape, drag points, add/delete points, grow/shrink, relabel, change category, set confidence, draw freehand, delete, mark verified |
| Depth | Each feature gets a depth range interpolated along the core run |
| 3D | Straight-hole model from collar/azimuth/dip, coloured core segments by depth, hover tooltips, drilling simulation, translucent correlation surfaces between nearest holes |
| Export | Intervals CSV (collar, az, dip, from, to, label, category, confidence) and project JSON |

Known demo limits: straight holes (no downhole survey), one core run per photo, correlation is nearest-neighbour and label-based, no auth, no server, LLM polygons are approximate, no calibration of image scale.

---

## 2. Production architecture

```
Browser (React + three.js / deck.gl)
   │  REST / WebSocket
FastAPI backend ── Celery workers ── GPU worker (SAM2 / detectors)
   │                    │
PostgreSQL + PostGIS    Claude API (vision, structured outputs, batch)
S3 / object storage     Redis (queues, cache)
```

### 2.1 Data model (PostGIS)

- `project(id, name, org_id, crs_epsg, deposit_style, created_by)`
- `hole(id, project_id, name, collar geometry(PointZ, crs), azimuth, dip, length, planned_length, status)`
- `survey(hole_id, depth, azimuth, dip)`: downhole survey, used instead of straight line when present
- `core_image(id, hole_id, from_m, to_m, row_index, direction, storage_key, width_px, height_px, scale_px_per_cm, status)`
- `feature(id, image_id, label, category, confidence, geom_image geometry(Polygon|LineString), from_m, to_m, source enum[ai,user,sam], verified bool, created_by)`
- `interval_log(hole_id, from_m, to_m, lithology, alteration, sulphide_pct, minerals jsonb, source)`: the composited, assay-ready log
- `assay(hole_id, from_m, to_m, element, value, unit, lab_batch)`: for validation and model training
- `edit_event(feature_id, user_id, before jsonb, after jsonb, ts)`: audit trail and training data

Store image-space geometry normalised (0..1) plus the original pixel size, and derive 3D coordinates on demand.

### 2.2 Claude features to use

| Need | Claude feature | Notes |
|---|---|---|
| Read the photo | Vision (image input) | Resize to ~1568 px on the long edge; send crops for deep-dive |
| Reliable JSON | Structured outputs / JSON schema or tool use with a strict `input_schema` | Remove regex parsing; validate with pydantic |
| Many images | Message Batches API | ~50% cheaper for bulk back-logging of whole holes |
| Repeated prompts | Prompt caching | Cache the system prompt, logging code, deposit-specific guidance |
| Hard calls | Extended thinking | Use for ambiguous crops and QA passes |
| Per-company standards | System prompt + few-shot examples + Files API | Upload the company’s logging code (lithology/alteration dictionaries) |
| Workflows | Agent SDK / tool use / MCP | Tools: `get_hole`, `get_survey`, `get_assays`, `write_interval_log`, `run_correlation` |
| Cross-checks | Multi-image prompts | Send adjacent trays for continuity; send core + assay table for consistency checks |
| Reports | Claude generates hole summaries and drilling reports from `interval_log` | Always from stored data, not from memory |

Prompt pattern used in the demo (keep it, add a schema):

1. Define the role and the logging dictionary.
2. Say what is out of scope (trays, labels, rulers).
3. Require terse structured output with confidence 0-100.
4. Ask for polygons that follow real boundaries, normalised 0-1000.
5. Add the deposit style, hole, depth range, dip and azimuth as context.

### 2.3 Better annotations than LLM polygons

LLM coordinates are approximate. For production, use a two-stage pipeline:

1. **Claude** proposes what is there: labels, confidence, rough point or box per feature.
2. **Segment Anything 2 (SAM 2)** converts each rough point/box into a pixel-accurate mask. Convert masks to polygons with `cv2.findContours` + `shapely.simplify`.
3. **Claude** classifies each mask crop (mineral, alteration, texture) with the crop at full resolution.
4. Geologist edits in the browser; edits are stored and later used to fine-tune a detector (YOLOv8-seg / Mask2Former).

Also add:
- **Core finding**: a tray/core segmentation model (SAM 2 or a small U-Net) so trays and labels are removed before any LLM call.
- **Depth blocks**: OCR depth markers with PaddleOCR or Tesseract to set `from_m/to_m` automatically; reconcile with user input.
- **Scale and colour calibration**: ArUco markers or a printed colour card in each photo; use OpenCV for perspective correction and `px_per_cm`. This unlocks real widths (vein mm), RQD and recovery.
- **Wet/dry and lighting normalisation**: require a capture guideline; add histogram equalisation.

### 2.4 Geospatial and geoscience packages

**Python backend**

| Task | Package |
|---|---|
| Vector data, CRS, GeoPackage I/O | `geopandas`, `shapely`, `pyproj`, `fiona`/`pyogrio` |
| Raster/imagery (maps, DEM) | `rasterio`, `xarray`, `rioxarray` |
| Drillhole objects, desurvey, compositing | `pandas` + minimum curvature desurvey (write or use `pyvista`/`welly` helpers); `lasio` for LAS logs; `welly` for well-style logs |
| 3D meshes and sections | `pyvista` (VTK), `trimesh`, `scipy.spatial` |
| Interpolation / geostatistics | `PyKrige`, `gstools`, `scikit-gstat`, `scipy.interpolate.RBFInterpolator` |
| Implicit geological modelling | `GemPy`, `LoopStructural` (faults, contacts, folds from orientations + contacts) |
| Geophysics (later) | `SimPEG`, `pygimli` |
| Image/ML | `opencv-python`, `scikit-image`, `torch`, `segment-anything-2`, `ultralytics` |
| OCR | `paddleocr`, `pytesseract` |
| Backend | `fastapi`, `sqlalchemy` + `geoalchemy2`, `celery`, `pydantic` |
| Export | GeoPackage (`.gpkg`), CSV (collar/survey/interval), VTK/`.vtp`, DXF (`ezdxf`), PLY/OBJ (`trimesh`) |

**Frontend**

| Task | Package |
|---|---|
| 3D scene | `three.js` (+ `OrbitControls`, `TubeGeometry` for curved holes), React Three Fiber |
| Large geo scenes / maps | `deck.gl`, `CesiumJS`, `MapLibre GL` |
| Annotation canvas | `Konva`, `Fabric.js` or `paper.js` (for bezier editing, undo/redo) |
| State | `zustand`, `react-query` |

### 2.5 Desurvey and 3D (correct approach)

The demo uses a straight line. In production:

1. Store survey stations `(depth, azimuth, dip)`.
2. Desurvey with the **minimum curvature** method to get X, Y, Z at any depth.
3. Interpolate each feature’s `from_m/to_m` to 3D with that path.
4. Render with `TubeGeometry` along the desurveyed curve; colour by logged property.

### 2.6 Cross-hole modelling roadmap

| Level | Method | Output |
|---|---|---|
| 1 (demo) | Nearest-neighbour label matching | Translucent correlation ribbons |
| 2 | Interval compositing + 3D indicator/ordinary kriging (`PyKrige`, `gstools`) | Grade/probability block model, iso-surfaces via marching cubes (`skimage.measure.marching_cubes`) |
| 3 | Implicit modelling (`LoopStructural`/`GemPy`) from contacts, dips and faults | Lithology volumes, fault network, cross-sections |
| 4 | Oriented structures from core (alpha/beta angles with core orientation) | Real strike/dip, structural domains, stereonets (`mplstereonet`) |
| 5 | Geophysics + remote sensing joint models | Targeting layers |

### 2.7 Drilling simulation

Today: animate bit depth along each hole and reveal intervals as the bit passes them. Next:
- real timestamps from drilling data (`from_m` per shift) to replay the actual campaign
- bit depth vs time curve, penetration rate, and live “what was found” panel
- planned vs actual hole paths, with deviation alarms

---

## 3. Product workflow for the geologist

1. **Create project**: CRS, deposit style, logging dictionary.
2. **Import collars and surveys**: CSV/GeoPackage/Excel templates.
3. **Add core photos**: one photo at a time or bulk; depth from OCR or typed.
4. **AI pre-log**: runs in the background; show progress per hole.
5. **Review and edit**: polygon editor with keyboard shortcuts, verified status, comments.
6. **QA/QC**: compare with assays and previous loggers; flag low-confidence or contradictory intervals.
7. **Model**: 3D view, sections, correlation, grade shells.
8. **Export**: interval log, GeoPackage, VTK, DXF, PDF report.

### Multi-user and trust

- Roles: logger, reviewer, project owner; every AI call and every edit stored with user and timestamp.
- Never overwrite human edits when re-running AI; add a new proposal layer.
- Show confidence and `source` (ai/sam/user) everywhere.

---

## 4. Validation (what makes it sellable)

Geologists will ask how accurate it is. Plan for:

1. A labelled benchmark: 200-500 photos logged by senior geologists, per deposit style.
2. Metrics: mineral recall/precision, polygon IoU, sulphide % error, interval agreement with assays (e.g. correlation between estimated sulphide % and Cu/Zn/Fe assay).
3. Calibrated confidence: fit reliability curves so “80%” means about 80% correct.
4. Human-in-the-loop stats: average edit distance and time saved per metre.
5. Clear claim: “assists logging, does not replace assay or a qualified person”.

---

## 5. Security and compliance

- Exploration data is commercially sensitive: per-tenant isolation, encryption at rest and in transit, SSO (OIDC/SAML), audit logs.
- Options: SaaS, private cloud, or on-premise inference for large miners.
- Data retention and no-training guarantees in the contract.
- Backups and versioned geometry (PostGIS + event log).

---

## 6. Build plan

| Phase | Weeks | Deliverables |
|---|---|---|
| 0 Prototype | done | This HTML demo |
| 1 MVP | 6-8 | Auth, projects/holes/images in Postgres + S3, Claude structured outputs, polygon editor with undo/redo, intervals CSV export |
| 2 Accuracy | 6-8 | SAM 2 masks, OCR depth, scale calibration, benchmark and confidence calibration |
| 3 3D and modelling | 8-10 | Survey desurvey, tube rendering, sections, kriging shells, GeoPackage/VTK/DXF export |
| 4 Enterprise | 8-12 | SSO, roles, audit, on-prem, integrations (Leapfrog, Surpac, Micromine, acQuire, Datamine) |

### Pricing ideas

Per-metre logged, per-seat subscription, or per-project with an enterprise tier. Anchor on hours saved per 100 m of core.

---

## 7. Quick start for the backend (sketch)

```python
# pip install anthropic fastapi pydantic geopandas shapely
import anthropic, base64
from pydantic import BaseModel

class Feature(BaseModel):
    label: str
    category: str  # mineralization|alteration|vein|structure|lithology
    conf: int
    closed: bool
    pts: list[list[int]]  # 0-1000 normalised

class Log(BaseModel):
    headline: str
    features: list[Feature]

client = anthropic.Anthropic()
img = base64.standard_b64encode(open("tray.jpg", "rb").read()).decode()
msg = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=4000,
    system="You are an exploration geologist logging drill core. Rock core only. ...",
    tools=[{"name": "record_log", "description": "Record the core log",
            "input_schema": Log.model_json_schema()}],
    tool_choice={"type": "tool", "name": "record_log"},
    messages=[{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": img}},
        {"type": "text", "text": "Hole DDH-001, 112.0-118.5 m, porphyry Cu-Au."}]}],
)
log = Log(**msg.content[0].input)
```

Use the model name current at build time; check Anthropic’s documentation for the latest model strings and structured-output options.

---

## 8. Disclaimer

Visual AI estimates (sulphide %, mineral identification, alteration) are indicative. Results must be verified by a qualified geologist and by laboratory assay before any resource, reserve or investment decision.
