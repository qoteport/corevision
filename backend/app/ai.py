"""Claude vision logging of a core photo, with schema-constrained JSON output."""
import base64
import json

import anthropic
from pydantic import BaseModel, Field, ValidationError

from . import config
from .geo import CATEGORIES, OPEN_CATEGORIES


class KPI(BaseModel):
    sulphide_pct: float = 0
    vein_pct: float = 0
    alteration_score: float = 0  # 0-5
    prospectivity: float = 0  # 0-100


class Mineral(BaseModel):
    name: str
    pct: float = 0
    conf: int = 0
    style: str = ""


class Lith(BaseModel):
    unit: str
    pct: float = 0


class Annotation(BaseModel):
    label: str
    category: str
    conf: int = 0
    closed: bool = True
    pts: list[list[float]] = Field(default_factory=list)


class Break(BaseModel):
    x: float
    y: float
    natural: bool = True


class CoreLog(BaseModel):
    core_boxes: list[list[float]] = Field(default_factory=list)
    headline: str = ""
    kpi: KPI = Field(default_factory=KPI)
    minerals: list[Mineral] = Field(default_factory=list)
    lithology: list[Lith] = Field(default_factory=list)
    annotations: list[Annotation] = Field(default_factory=list)
    breaks: list[Break] = Field(default_factory=list)


def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


_INT_PAIR = {"type": "array", "items": {"type": "integer"}}

SCHEMA = _obj({
    "core_boxes": {"type": "array", "items": _INT_PAIR,
                   "description": "Rock-core bounding boxes [x0,y0,x1,y1] in 0-1000 image coordinates"},
    "headline": {"type": "string"},
    "kpi": _obj({"sulphide_pct": {"type": "number"}, "vein_pct": {"type": "number"},
                 "alteration_score": {"type": "number"}, "prospectivity": {"type": "number"}}),
    "minerals": {"type": "array", "items": _obj({"name": {"type": "string"}, "pct": {"type": "number"},
                                                 "conf": {"type": "integer"}, "style": {"type": "string"}})},
    "lithology": {"type": "array", "items": _obj({"unit": {"type": "string"}, "pct": {"type": "number"}})},
    "annotations": {"type": "array", "items": _obj({
        "label": {"type": "string"},
        "category": {"type": "string", "enum": CATEGORIES},
        "conf": {"type": "integer"},
        "closed": {"type": "boolean"},
        "pts": {"type": "array", "items": _INT_PAIR, "description": "[x,y] points, 0-1000"},
    })},
    "breaks": {"type": "array", "description": "Every place the core is broken across its axis",
               "items": _obj({"x": {"type": "integer"}, "y": {"type": "integer"},
                              "natural": {"type": "boolean", "description": "true = natural fracture/joint/vein "
                                          "parting; false = drilling or handling break"}})},
})

SYSTEM = """You are an expert exploration geologist logging diamond drill core from photographs.

Scope: annotate ROCK CORE ONLY. Never annotate core trays, boxes, depth blocks, labels, rulers, hands, \
tape or background. First locate every core row and report it in core_boxes.

Coordinates are integers 0-1000 normalised to the image (x to the right, y down).

Annotations: give 6-16 features, all on core. Outline each feature with a polygon of 8-20 points that \
follows its real, irregular boundary (not a rectangle) and set closed=true. Veins, fractures, faults and \
other structures are open polylines that trace the feature (closed=false). Categories: mineralization, \
alteration, vein, structure, lithology.

Breaks (for RQD and fracture frequency): mark every break across the core with one point on the core \
centre line. natural=true for natural fractures, joints and open vein partings (rough, weathered, coated or \
slickensided surfaces); natural=false for drilling-induced or handling breaks (fresh, clean, perpendicular \
to the core axis, matching faces) and breaks made to fit the core into the tray. Do not mark tray row ends.

Be terse: labels and styles are a number or a phrase of at most 6 words; headline at most 12 words. \
conf is 0-100 and should reflect real uncertainty: from a photo you can be sure of textures and colours, \
much less of mineral species. KPIs: sulphide_pct and vein_pct are visual area percentages of the core, \
alteration_score is 0-5, prospectivity is 0-100.

These are indicative visual estimates for a geologist to verify, not assay results."""

DEPOSIT_HINTS = {
    "Orogenic gold": "Look for quartz-carbonate veins, laminated/shear veins, sericite-carbonate-albite "
                     "alteration, arsenopyrite, pyrite, pyrrhotite; visible gold is rare.",
    "Epithermal gold": "Look for banded/colloform/crustiform quartz, adularia, bladed calcite, silicification, "
                       "argillic/advanced argillic alteration, fine pyrite, sulphosalts.",
    "Porphyry Cu-Au": "Look for A/B/D vein generations, stockwork, potassic (K-feldspar, biotite, magnetite), "
                      "phyllic (QSP), propylitic (chlorite-epidote); chalcopyrite, bornite, molybdenite, pyrite.",
    "VMS base metals": "Look for massive/semi-massive sulphide, banding, sphalerite, galena, chalcopyrite, "
                       "pyrite, chlorite-sericite footwall alteration, stringer zones.",
    "Iron ore": "Look for banded iron formation, magnetite/hematite bands, martite, goethite, chert, "
                "enrichment textures.",
    "Ni sulphide": "Look for ultramafic hosts, net-textured and massive sulphide, pentlandite, pyrrhotite, "
                   "chalcopyrite, serpentinisation, talc-carbonate alteration.",
    "Li pegmatite": "Look for coarse spodumene, petalite, lepidolite, albite, quartz-feldspar zoning, "
                    "tourmaline, wall-rock holmquistite.",
}


class AnalysisError(Exception):
    pass


def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic(max_retries=3)


def build_context(project: dict, hole: dict, image: dict, codes: list[dict] | None = None) -> str:
    parts = [f"Project: {project['name']}",
             f"Hole: {hole['name']} (azimuth {hole['azimuth']}°, dip {hole['dip']}°, core size {hole.get('core_size') or 'NQ'})"]
    if image.get("from_m") is not None and image.get("to_m") is not None:
        parts.append(f"Core run: {image['from_m']}-{image['to_m']} m")
    direction = {"lr": "left to right", "rl": "right to left", "tb": "top to bottom", "bt": "bottom to top"}
    parts.append(f"Depth increases {direction.get(image.get('direction') or 'lr')} in the photo")
    dep = project.get("deposit_style") or ""
    if dep:
        parts.append(f"Deposit style: {dep}. {DEPOSIT_HINTS.get(dep, '')}".strip())
    if codes:
        # Company logging dictionary: labels should use these codes so the log imports cleanly.
        parts.append("Project logging codes. Start each label with the matching code where one fits "
                     "(e.g. 'CPY disseminated'):")
        for field in ("lithology", "alteration", "mineralization"):
            items = [f"{c['code']}={c['description']}" if c.get("description") else c["code"]
                     for c in codes if c["field"] == field]
            if items:
                parts.append(f"  {field}: " + ", ".join(items))
    return "\n".join(parts)


def analyze_image(jpeg: bytes, context: str) -> tuple[CoreLog, str]:
    """Send one core photo to Claude. Returns the validated log and the model that served it."""
    kwargs = dict(
        model=config.MODEL,
        max_tokens=16000,
        system=SYSTEM,
        thinking={"type": "adaptive"},
        output_config={"effort": config.EFFORT, "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                         "data": base64.standard_b64encode(jpeg).decode()}},
            {"type": "text", "text": context + "\n\nLog this core photo."},
        ]}],
    )
    if config.USE_FALLBACKS:
        # Server-side fallback: if a safety classifier declines, the API reroutes to a fallback model.
        kwargs.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    try:
        msg = _client().beta.messages.create(**kwargs)
    except anthropic.AuthenticationError as e:
        raise AnalysisError("API key rejected. Check ANTHROPIC_API_KEY.") from e
    except anthropic.PermissionDeniedError as e:
        raise AnalysisError(f"Permission denied by the API: {e.message}") from e
    except anthropic.NotFoundError as e:
        raise AnalysisError(f"Model not found: {config.MODEL}") from e
    except anthropic.RateLimitError as e:
        raise AnalysisError("Rate limited by the API. Try again shortly.") from e
    except anthropic.BadRequestError as e:
        raise AnalysisError(f"Request rejected: {e.message}") from e
    except anthropic.APIStatusError as e:
        raise AnalysisError(f"API error {e.status_code}. Try again.") from e
    except anthropic.APIConnectionError as e:
        raise AnalysisError("Could not reach the Claude API.") from e

    if msg.stop_reason == "refusal":
        raise AnalysisError("The model declined to analyse this image.")
    if msg.stop_reason == "max_tokens":
        raise AnalysisError("The response was cut off. Re-analyze or lower CV_EFFORT.")
    text = next((b.text for b in msg.content if b.type == "text"), "")
    try:
        log = CoreLog.model_validate(json.loads(text))
    except (json.JSONDecodeError, ValidationError) as e:
        raise AnalysisError("The model returned malformed output. Re-analyze.") from e
    return log, msg.model


def clean_breaks(log: CoreLog) -> list[dict]:
    """Keep breaks that fall on (or very near) a detected core row; clamp to the frame."""
    boxes = [b for b in log.core_boxes if len(b) == 4]
    out = []
    for b in log.breaks:
        x, y = min(1000.0, max(0.0, b.x)), min(1000.0, max(0.0, b.y))
        if boxes and not any(bx[0] - 10 <= x <= bx[2] + 10 and bx[1] - 10 <= y <= bx[3] + 10 for bx in boxes):
            continue
        out.append({"x": x, "y": y, "natural": b.natural})
    return out


def clean_annotations(log: CoreLog) -> list[dict]:
    """Validate points, clamp to the frame, and drop features whose centre is off the core."""
    boxes = [b for b in log.core_boxes if len(b) == 4]
    out = []
    for a in log.annotations:
        if a.category not in CATEGORIES:
            continue
        pts = [[min(1000.0, max(0.0, float(p[0]))), min(1000.0, max(0.0, float(p[1])))]
               for p in a.pts if len(p) == 2]
        if len(pts) < 2:
            continue
        if boxes:
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            if not any(b[0] - 15 <= cx <= b[2] + 15 and b[1] - 15 <= cy <= b[3] + 15 for b in boxes):
                continue
        closed = a.category not in OPEN_CATEGORIES and a.closed and len(pts) >= 3
        out.append({"label": a.label.strip() or "feature", "category": a.category,
                    "confidence": max(0, min(100, int(a.conf))), "closed": closed, "pts": pts})
    return out
