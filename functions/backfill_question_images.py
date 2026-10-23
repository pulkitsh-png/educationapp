"""
backfill_question_images.py

One-off maintenance script for KidsPlanner's Study & Exam feature.

Cropping (the picture shown inline with a question) only exists for
questions generated after the cropping feature shipped. Older questions
were generated with no idea of "does this need a picture" or "where is it
on the page" -- that information was never computed, so it can't be shown
retroactively without computing it.

This script fills that gap WITHOUT regenerating the questions themselves:
for each already-uploaded page, it re-sends the page to Gemini along with
the exact text of the questions that were already generated from it, and
asks only "for each of these existing questions, does it need a picture,
and if so where is it" -- never asking Gemini to rewrite the question,
options, or answer. Then it crops and uploads the image exactly like the
live pipeline does for new uploads.

Skips any question that's already been looked at (imageBackfillDone is
set), so it's safe to re-run if it gets interrupted partway through.

SETUP:
  1. $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\\path\\to\\serviceAccountKey.json"
  2. $env:GEMINI_API_KEY = "<your Gemini API key>"
  3. functions\\venv\\Scripts\\Activate.ps1  (needs firebase-admin, google-genai,
     Pillow, pypdfium2 -- all already in functions\\requirements.txt)

USAGE:
  # Preview what would be processed, without writing or uploading anything:
  python functions\\backfill_question_images.py --dry-run

  # Actually do it:
  python functions\\backfill_question_images.py

  # Just a few pages first, to sanity-check before running the whole set:
  python functions\\backfill_question_images.py --limit 3
"""

import argparse
import io
import json
import os
import re
import sys
import time
from collections import defaultdict

import firebase_admin
from firebase_admin import firestore, storage
from google import genai
from google.genai import types
from PIL import Image

MAX_RETRIES = 3
RETRY_BASE_DELAY_SECONDS = 2


def mime_type_for(name: str) -> str:
    ext = (name.rsplit(".", 1)[-1] if "." in name else "").lower()
    return {
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "webp": "image/webp", "heic": "image/heic", "heif": "image/heif",
        "pdf": "application/pdf",
    }.get(ext, "image/jpeg")


def render_source_to_image(file_bytes: bytes, mime_type: str, pdf_page_index):
    if mime_type.startswith("image/"):
        return Image.open(io.BytesIO(file_bytes)).convert("RGB")
    if mime_type == "application/pdf":
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(file_bytes)
        try:
            idx = pdf_page_index if isinstance(pdf_page_index, int) and 0 <= pdf_page_index < len(pdf) else 0
            bitmap = pdf[idx].render(scale=3)
            return bitmap.to_pil().convert("RGB")
        finally:
            pdf.close()
    return None


def crop_region(file_bytes: bytes, mime_type: str, region: dict, pdf_page_index) -> bytes | None:
    try:
        y_min, x_min, y_max, x_max = (region.get(k) for k in ("yMin", "xMin", "yMax", "xMax"))
        if None in (y_min, x_min, y_max, x_max):
            return None
        img = render_source_to_image(file_bytes, mime_type, pdf_page_index)
        if img is None:
            return None
        w, h = img.size
        left = max(0, min(w, round(x_min / 1000 * w)))
        right = max(0, min(w, round(x_max / 1000 * w)))
        top = max(0, min(h, round(y_min / 1000 * h)))
        bottom = max(0, min(h, round(y_max / 1000 * h)))
        if right - left < 10 or bottom - top < 10:
            return None
        pad_x, pad_y = round((right - left) * 0.08), round((bottom - top) * 0.08)
        left, right = max(0, left - pad_x), min(w, right + pad_x)
        top, bottom = max(0, top - pad_y), min(h, bottom + pad_y)
        out = io.BytesIO()
        img.crop((left, top, right, bottom)).save(out, format="JPEG", quality=85)
        return out.getvalue()
    except Exception:
        return None


PROMPT_TEMPLATE = """Below is a scanned textbook page (a single image, or a PDF that may contain one or more pages), followed by a numbered list of questions that were already written from this page. Do NOT rewrite, rephrase, or re-answer any of them -- they're final as-is.

For each numbered question, decide:
- "requiresImage": true only if the question genuinely cannot be answered from text alone -- e.g. "label the diagram", "what does the chart show", "identify the part shown in the picture", or it explicitly refers to a figure/example/table the student needs to look at. False for ordinary questions, even if the page happens to contain a picture somewhere.
- "imageRegion": ONLY when requiresImage is true -- the tight bounding box of the SPECIFIC diagram/chart/figure/table this question refers to (not the whole page), as {{"yMin":0,"xMin":0,"yMax":1000,"xMax":1000}} on a 0-1000 normalized scale where (0,0) is the page's top-left corner. When requiresImage is false, set to null.
- "pdfPageIndex": ONLY when the source is a multi-page PDF and requiresImage is true -- the 0-based index of the PDF page the imageRegion is on. Otherwise null.

Questions:
{question_list}

Return ONLY valid JSON, no markdown fences, no commentary -- an array with exactly {n} entries, in the same order as the questions above:
[
  {{ "index": 0, "requiresImage": false, "imageRegion": null, "pdfPageIndex": null }}
]"""


def generate_with_retry(client, **kwargs):
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            return client.models.generate_content(**kwargs)
        except Exception as e:
            last_err = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BASE_DELAY_SECONDS * (2 ** attempt))
    raise last_err


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=None, help="Only process this many source pages (for a quick test run).")
    args = parser.parse_args()

    gemini_key = os.environ.get("GEMINI_API_KEY")
    if not gemini_key:
        sys.exit('ERROR: GEMINI_API_KEY is not set.\n  $env:GEMINI_API_KEY = "<your Gemini API key>"')

    firebase_admin.initialize_app()
    db = firestore.client()
    bucket = storage.bucket()
    client = genai.Client(api_key=gemini_key)

    print("Scanning examQuestions for ones that haven't been looked at yet...")
    all_docs = list(db.collection("examQuestions").stream())
    candidates = []
    for doc in all_docs:
        q = doc.to_dict()
        if q.get("imageBackfillDone"):
            continue
        if not q.get("sourceImage"):
            continue
        if q.get("croppedImage"):
            continue
        candidates.append((doc.id, q))

    print(f"Found {len(all_docs)} question(s) total, {len(candidates)} candidate(s) to look at.")
    if not candidates:
        print("Nothing to do.")
        return

    groups = defaultdict(list)
    for doc_id, q in candidates:
        groups[q["sourceImage"]].append((doc_id, q))

    print(f"Grouped into {len(groups)} source page(s).")
    page_items = list(groups.items())
    if args.limit:
        page_items = page_items[: args.limit]
        print(f"--limit set: only processing the first {len(page_items)} page(s).")

    total_marked_requires_image = 0
    total_cropped = 0
    total_skipped_pages = 0

    for i, (source_image, items) in enumerate(page_items, 1):
        print(f"\n[{i}/{len(page_items)}] {source_image}  ({len(items)} question(s))")
        try:
            blob = bucket.blob(source_image)
            if not blob.exists():
                print("  SKIPPED -- source file no longer exists in Storage.")
                total_skipped_pages += 1
                continue
            file_bytes = blob.download_as_bytes()
        except Exception as e:
            print(f"  SKIPPED -- couldn't download source: {e}")
            total_skipped_pages += 1
            continue

        mime_type = mime_type_for(source_image)
        question_list = "\n".join(f"{idx}. {q.get('question', '')}" for idx, (_, q) in enumerate(items))
        prompt = PROMPT_TEMPLATE.format(question_list=question_list, n=len(items))

        if args.dry_run:
            print(f"  (dry run) would ask Gemini about {len(items)} question(s), then crop+upload as needed.")
            continue

        try:
            response = generate_with_retry(
                client,
                model="gemini-3.8-flash",
                contents=[prompt, types.Part.from_bytes(data=file_bytes, mime_type=mime_type)],
            )
            raw = re.sub(r"^```json\s*|\s*```$", "", response.text.strip())
            decisions = json.loads(raw)
        except Exception as e:
            print(f"  SKIPPED -- Gemini call/parse failed: {e}")
            total_skipped_pages += 1
            continue

        by_index = {d.get("index"): d for d in decisions if isinstance(d, dict)}
        batch = db.batch()
        ops = 0
        for idx, (doc_id, q) in enumerate(items):
            decision = by_index.get(idx, {})
            requires_image = bool(decision.get("requiresImage"))
            patch = {"imageBackfillDone": True, "requiresImage": requires_image}

            if requires_image and decision.get("imageRegion"):
                cropped_bytes = crop_region(file_bytes, mime_type, decision["imageRegion"], decision.get("pdfPageIndex"))
                if cropped_bytes:
                    crop_path = f"examPages/{q.get('childId')}/crops/{doc_id}.jpg"
                    try:
                        bucket.blob(crop_path).upload_from_string(cropped_bytes, content_type="image/jpeg")
                        patch["croppedImage"] = crop_path
                        total_cropped += 1
                    except Exception as e:
                        print(f"    (question {doc_id}) crop upload failed: {e}")
                total_marked_requires_image += 1

            batch.update(db.collection("examQuestions").document(doc_id), patch)
            ops += 1

        batch.commit()
        print(f"  Updated {ops} question(s); {sum(1 for d in decisions if d.get('requiresImage'))} need an image.")

    print("\n" + "=" * 50)
    if args.dry_run:
        print("DRY RUN COMPLETE -- nothing written")
    else:
        print("DONE")
        print(f"Pages processed: {len(page_items) - total_skipped_pages}/{len(page_items)} (skipped {total_skipped_pages})")
        print(f"Questions marked requiresImage=true: {total_marked_requires_image}")
        print(f"Images actually cropped+uploaded: {total_cropped}")
    print("=" * 50)


if __name__ == "__main__":
    main()
