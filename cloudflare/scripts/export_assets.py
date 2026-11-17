"""Export original UI/medical texts without editing them in the cloud port."""
import ast
import json
import sys
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from smoke import content, medical, ui

assets = {name: getattr(ui, name) for name in ("MENU_LABELS", "FIELDS", "LABELS", "PROMPTS", "CHOICES")}
assets.update({name: getattr(content, name) for name in ("GREETINGS", "THOUGHTS")})
assets.update({name: getattr(medical, name) for name in ("MODEL_NOTE", "HEALTH_NOTE", "ADDICTION")})
assets["STAGES"] = [asdict(s) for s in medical.STAGES]
# Preserve all literal Russian messages, including the long craving message.
tree = ast.parse((ROOT / "smoke/handlers.py").read_text(encoding="utf-8"))
assets["TEXTS"] = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and any("а" <= c.lower() <= "я" for c in n.value)]
(ROOT / "cloudflare/src/assets.json").write_text(json.dumps(assets, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
