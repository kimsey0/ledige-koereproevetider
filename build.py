"""Builds the Firefox add-on from the extension folder.

Chrome, Edge and Brave load the `extension` folder as it is (Manifest V3).
Firefox gets a Manifest V2 variant, because Firefox only runs Manifest V3
content scripts after the user grants site access by hand.

Usage: python build.py
Output: dist/firefox/ (loadable folder) and dist/ledige-tider-firefox-<version>.xpi
"""
import json
import re
import shutil
import zipfile
from pathlib import Path

root = Path(__file__).parent
src = root / "extension"
out = root / "dist" / "firefox"

manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]
script_version = re.search(r"const VERSION = '([^']+)'", (src / "content.js").read_text(encoding="utf-8")).group(1)
if script_version != version:
    raise SystemExit(f"Version mismatch: manifest {version}, content.js {script_version}")

firefox = {
    "manifest_version": 2,
    "name": manifest["name"],
    "version": version,
    "description": manifest["description"],
    "browser_specific_settings": {
        "gecko": {
            "id": "ledige-koereproevetider@kimsey0.github.io",
            "strict_min_version": "115.0",
            # Firefox checks this file for newer signed versions (self-hosted updates).
            "update_url": "https://raw.githubusercontent.com/kimsey0/ledige-koereproevetider/main/updates.json",
            "data_collection_permissions": {"required": ["none"]},
        }
    },
    "permissions": ["https://onlinebooking-api.prod.workforce-planner.dk/*"],
    "content_scripts": manifest["content_scripts"],
}

shutil.rmtree(out, ignore_errors=True)
out.mkdir(parents=True)
(out / "manifest.json").write_text(json.dumps(firefox, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
for script in {s for cs in manifest["content_scripts"] for s in cs["js"]}:
    shutil.copy(src / script, out / script)

xpi = root / "dist" / f"ledige-tider-firefox-{version}.xpi"
with zipfile.ZipFile(xpi, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(out.iterdir()):
        z.write(f, f.name)
print(xpi)

# Firefox only offers versions listed in updates.json, so flag a forgotten entry.
gecko = firefox["browser_specific_settings"]["gecko"]
listed = [u["version"] for u in json.loads((root / "updates.json").read_text(encoding="utf-8"))["addons"][gecko["id"]]["updates"]]
if version not in listed:
    print(f"WARNING: updates.json has no entry for {version}")
