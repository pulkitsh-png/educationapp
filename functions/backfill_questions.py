"""
backfill_questions.py

One-off maintenance script for KidsPlanner's Study & Exam feature.

Scans a folder (prefix) in your Firebase Storage bucket for scanned textbook
page images, skips any that already have generated questions in Firestore
(matched by sourceImage path), and generates + stores questions for the rest
-- using the exact same prompt/logic as the generateQuestionsFromImage Cloud
Function in functions/main.py.

SETUP (one time):
  1. Download a service account key:
     Firebase Console -> gear icon -> Project settings -> Service accounts
     -> "Generate new private key" -> save the JSON file somewhere safe,
     e.g. C:\\projects\\ivaan-education\\serviceAccountKey.json
     (Do NOT commit this file to git -- add it to .gitignore.)

  2. Copy this script into your functions folder:
     C:\\projects\\ivaan-education\\functions\\backfill_questions.py

  3. Activate your existing venv (it already has firebase-admin and
     google-genai installed):
       cd C:\\projects\\ivaan-education
       functions\\venv\\Scripts\\Activate.ps1

  4. Set two environment variables for this PowerShell session:
       $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\\projects\\ivaan-education\\serviceAccountKey.json"
       $env:GEMINI_API_KEY = "<your Gemini API key>"

USAGE:
  # See existing children and their Firestore doc IDs:
  python functions\\backfill_questions.py --list-children

  # Preview what would be processed, without writing anything:
  python functions\\backfill_questions.py --child-id <childId> --prefix myUploads --dry-run

  # Actually generate and store questions:
  python functions\\backfill_questions.py --child-id <childId> --prefix myUploads

  --prefix is the Storage "folder" the images are under. Leave it off (or
  pass "") to scan the whole bucket. Find the right prefix by looking at
  the path shown next to each file in Firebase Console -> Storage.
"""

import argparse
import json
import os
import re
import sys

import firebase_admin
from firebase_admin import credentials, firestore, storage
from google import genai
from google.genai import types

DIFFICULTIES = ["Simple", "Medium", "Hard", "Complex"]
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif")

PROMPT_TEMPLATE = """You are helping a parent create practice questions from a scanned page of their 5th grader's textbook{subject_part}.

Read the page content in the image, then write exactly 8 multiple-choice questions testing understanding of it: 2 "Simple" (direct recall), 2 "Medium" (connecting two facts), 2 "Hard" (applying or explaining why), 2 "Complex" (reasoning across multiple ideas on the page).

Return ONLY valid JSON, no markdown fences, no commentary:
{{
  "topic": "short topic name",
  "subject": "Science | Math | English | Social Studies | Other",
  "questions": [
    {{ "difficulty": "Simple", "question": "...", "options": ["...","...","...","..."], "correctIndex": 0, "explanation": "one sentence" }}
  ]
}}"""


def init_firebase():
    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not cred_path or not os.path.isfile(cred_path):
        sys.exit(
            "ERROR: GOOGLE_APPLICATION_CREDENTIALS is not set to a valid file.\n"
            "Set it to the path of your downloaded service account key JSON, e.g.\n"
            '  $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\\projects\\ivaan-education\\serviceAccountKey.json"'
        )
    cred = credentials.Certificate(cred_path)
    firebase_admin.initialize_app(cred)


def get_gemini_key():
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit(
            "ERROR: GEMINI_API_KEY is not set.\n"
            '  $env:GEMINI_API_KEY = "<your Gemini API key>"'
        )
    return key


def mime_type_for(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".heic": "image/heic",
        ".heif": "image/heif",
    }.get(ext, "image/jpeg")


def list_children(db):
    print("\nChildren in Firestore:")
    print("-" * 50)
    for doc in db.collection("children").order_by("order").stream():
        d = doc.to_dict()
        print(f"  id={doc.id}   name={d.get('name')}")
    print("-" * 50)


def already_processed(db, blob_name: str) -> bool:
    existing = (
        db.collection("examQuestions")
        .where("sourceImage", "==", blob_name)
        .limit(1)
        .get()
    )
    return len(existing) > 0


def generate_for_blob(db, client, bucket, blob, child_id: str, subject_hint: str, dry_run: bool):
    print(f"\n-> Processing: {blob.name}")
    img_bytes = blob.download_as_bytes()

    subject_part = f" (subject: {subject_hint})" if subject_hint else ""
    prompt = PROMPT_TEMPLATE.format(subject_part=subject_part)

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=[prompt, types.Part.from_bytes(data=img_bytes, mime_type=mime_type_for(blob.name))],
    )
    raw = re.sub(r"^```json\s*|\s*```$", "", response.text.strip())
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        print(f"   SKIPPED (could not parse AI response as JSON): {blob.name}")
        return 0

    questions = parsed.get("questions", [])
    print(f"   Topic: {parsed.get('topic')}  Subject: {parsed.get('subject')}  Questions: {len(questions)}")

    if dry_run:
        print("   (dry run -- nothing written)")
        return len(questions)

    batch = db.batch()
    for q in questions:
        ref = db.collection("examQuestions").document()
        batch.set(ref, {
            "childId": child_id,
            "subject": parsed.get("subject", "Other"),
            "topic": parsed.get("topic", "Untitled"),
            "difficulty": q.get("difficulty") if q.get("difficulty") in DIFFICULTIES else "Medium",
            "question": q.get("question"),
            "options": q.get("options"),
            "correctIndex": q.get("correctIndex"),
            "explanation": q.get("explanation", ""),
            "sourceImage": blob.name,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "createdBy": "backfill-script",
        })
    batch.commit()
    print(f"   Wrote {len(questions)} questions to Firestore.")
    return len(questions)


def main():
    parser = argparse.ArgumentParser(description="Backfill exam questions from already-uploaded scanned pages.")
    parser.add_argument("--child-id", help="Firestore document ID of the child these pages belong to.")
    parser.add_argument("--prefix", default="", help='Storage folder to scan, e.g. "myUploads". Empty = whole bucket.')
    parser.add_argument("--subject-hint", default="", help="Optional subject hint, e.g. Science.")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, write nothing.")
    parser.add_argument("--list-children", action="store_true", help="List child IDs and exit.")
    args = parser.parse_args()

    init_firebase()
    db = firestore.client()

    if args.list_children:
        list_children(db)
        return

    if not args.child_id:
        sys.exit("ERROR: --child-id is required (use --list-children to find it).")

    gemini_key = get_gemini_key()
    client = genai.Client(api_key=gemini_key)
    bucket = storage.bucket()

    blobs = list(bucket.list_blobs(prefix=args.prefix))
    image_blobs = [b for b in blobs if b.name.lower().endswith(IMAGE_EXTENSIONS)]

    print(f"Found {len(image_blobs)} image(s) under prefix '{args.prefix}'.")

    total_new_questions = 0
    processed = 0
    skipped = 0

    for blob in image_blobs:
        if already_processed(db, blob.name):
            print(f"\n-> Skipping (already has questions): {blob.name}")
            skipped += 1
            continue
        count = generate_for_blob(db, client, bucket, blob, args.child_id, args.subject_hint, args.dry_run)
        total_new_questions += count
        processed += 1

    print("\n" + "=" * 50)
    print(f"Done. Processed {processed} new page(s), skipped {skipped} already-done page(s).")
    print(f"Total questions generated: {total_new_questions}")
    if args.dry_run:
        print("(dry run -- nothing was actually written to Firestore)")
    print("=" * 50)


if __name__ == "__main__":
    main()
