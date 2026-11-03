"""Runtime settings, read from environment variables (or a .env file in the project root)."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv() -> None:
    env = ROOT / ".env"
    if not env.exists() or os.environ.get("CV_NO_DOTENV") == "1":  # tests set CV_NO_DOTENV
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

DATA_DIR = Path(os.environ.get("CV_DATA_DIR", ROOT / "data"))
IMAGE_DIR = DATA_DIR / "images"
DB_PATH = DATA_DIR / "corevision.db"
FRONTEND_DIR = ROOT / "frontend" / "dist"  # React build output (npm run build)

MODEL = os.environ.get("CV_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("CV_EFFORT", "high")  # low | medium | high | xhigh | max
USE_FALLBACKS = os.environ.get("CV_FALLBACKS", "1") != "0"
MAX_EDGE_PX = 1568  # long edge sent to the vision model

# Database: SQLite file under CV_DATA_DIR unless DATABASE_URL points at Postgres, e.g.
#   postgresql://user:pass@/corevision?host=/cloudsql/PROJECT:REGION:INSTANCE   (Cloud SQL on Cloud Run)
#   postgresql://user:pass@localhost:5432/corevision
_db = os.environ.get("DATABASE_URL", "").strip()
if _db.startswith("postgres://"):
    _db = "postgresql://" + _db[len("postgres://"):]
DATABASE_URL = _db if _db.startswith("postgresql://") else None
DB_POOL_SIZE = int(os.environ.get("CV_DB_POOL_SIZE", "8"))

# Photo storage: local disk under CV_DATA_DIR, or a Google Cloud Storage bucket when CV_GCS_BUCKET is set.
GCS_BUCKET = os.environ.get("CV_GCS_BUCKET", "").strip() or None
GCS_PREFIX = os.environ.get("CV_GCS_PREFIX", "images/")

IMAGE_DIR.mkdir(parents=True, exist_ok=True)


def ai_configured() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
