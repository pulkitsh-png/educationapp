"""
cleanup_crop_loop.py

One-off cleanup for the "crop re-trigger loop": process_exam_page used to run
on its own cropped figures (examPages/{childId}/crops/...), generating junk
questions whose sourceImage is a crop and no chapter, plus more crops.

What it removes:
  1. examQuestions docs whose sourceImage contains "/crops/" (junk questions
     generated FROM a crop). Real questions are never touched: their
     sourceImage is the original page, and their croppedImage field only
     *points at* a crop.
  2. Storage files under examPages/*/crops/ that no remaining question
     references via croppedImage (orphaned crops).

SETUP:  $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\\path\\to\\serviceAccountKey.json"
USAGE:
  python cleanup_crop_loop.py            # preview only (default) -- deletes nothing
  python cleanup_crop_loop.py --delete   # actually delete
Deploy the process_exam_page guard FIRST, or new crops will keep re-triggering.
"""
import argparse

import firebase_admin
from firebase_admin import firestore, storage


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--delete", action="store_true", help="actually delete (default is preview only)")
    args = ap.parse_args()

    firebase_admin.initialize_app(options={"storageBucket": "kidsplanner-564e3.firebasestorage.app"})
    db = firestore.client()
    bucket = storage.bucket()

    junk_refs, keep_crops = [], set()
    total = 0
    for doc in db.collection("examQuestions").stream():
        total += 1
        q = doc.to_dict()
        if "/crops/" in (q.get("sourceImage") or ""):
            junk_refs.append(doc.reference)
        elif q.get("croppedImage"):
            keep_crops.add(q["croppedImage"])
    print(f"examQuestions scanned: {total}")
    print(f"junk questions (sourceImage is a crop): {len(junk_refs)}")
    print(f"crops referenced by real questions (kept): {len(keep_crops)}")

    orphan_blobs = [b for b in bucket.list_blobs(prefix="examPages/")
                    if "/crops/" in b.name and b.name not in keep_crops]
    print(f"orphaned crop files in Storage: {len(orphan_blobs)}")

    if not args.delete:
        print("\nPreview only. Re-run with --delete to remove them.")
        return

    for i in range(0, len(junk_refs), 400):
        batch = db.batch()
        for ref in junk_refs[i:i + 400]:
            batch.delete(ref)
        batch.commit()
    print(f"deleted {len(junk_refs)} junk questions")
    for b in orphan_blobs:
        try:
            b.delete()
        except Exception as e:
            print("could not delete", b.name, e)
    print(f"deleted {len(orphan_blobs)} orphaned crop files")


if __name__ == "__main__":
    main()
