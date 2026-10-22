import io
import json
import re
import time

from firebase_functions import https_fn, storage_fn, options
from firebase_functions.params import SecretParam
import firebase_admin
from firebase_admin import firestore, storage
from google import genai
from google.genai import types
from PIL import Image

firebase_admin.initialize_app()

_db = None
def get_db():
    global _db
    if _db is None:
        _db = firestore.client()
    return _db

GEMINI_API_KEY = SecretParam("GEMINI_API_KEY")
DIFFICULTIES = ["Simple", "Medium", "Hard", "Complex"]

RETRYABLE_STATUS_CODES = (429, 500, 503, 504)
MAX_RETRIES = 3
RETRY_BASE_DELAY_SECONDS = 2


def _generate_with_retry(client, **kwargs):
    """Calls Gemini, automatically retrying a few times (with backoff) on
    transient errors like rate limits or temporary overload, instead of
    failing on the first hiccup."""
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return client.models.generate_content(**kwargs)
        except Exception as e:
            status_code = getattr(e, "code", None) or getattr(e, "status_code", None)
            last_error = e
            if status_code not in RETRYABLE_STATUS_CODES or attempt == MAX_RETRIES:
                raise
            time.sleep(RETRY_BASE_DELAY_SECONDS * attempt)
    raise last_error


def _guess_mime_type(path: str) -> str:
    ext = path.lower().rsplit(".", 1)[-1] if "." in path else ""
    return {
        "pdf": "application/pdf",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "heic": "image/heic",
        "heif": "image/heif",
    }.get(ext, "image/jpeg")


def _render_source_to_image(file_bytes: bytes, mime_type: str, pdf_page_index: int | None) -> "Image.Image | None":
    """Returns a PIL Image of the page to crop from -- either the uploaded
    image as-is, or (for a PDF) that specific page rendered to a raster
    image via pypdfium2 at a high enough resolution for a clean crop.
    Returns None on any failure or an unsupported type."""
    if mime_type.startswith("image/"):
        return Image.open(io.BytesIO(file_bytes)).convert("RGB")
    if mime_type == "application/pdf":
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(file_bytes)
        try:
            page_index = pdf_page_index if isinstance(pdf_page_index, int) and 0 <= pdf_page_index < len(pdf) else 0
            page = pdf[page_index]
            # scale=3 -> ~216 DPI off a standard 72-DPI PDF page; plenty
            # sharp for a cropped figure without being huge.
            bitmap = page.render(scale=3)
            return bitmap.to_pil().convert("RGB")
        finally:
            pdf.close()
    return None


def _crop_image_region(file_bytes: bytes, mime_type: str, region: dict | None, pdf_page_index: int | None = None) -> bytes | None:
    """Crops the figure/diagram a question refers to out of the full scanned
    page (rendering the right page first if the source is a PDF), so the
    question can show just that picture instead of a link to the whole
    page. `region` is Gemini's bounding box for that figure -- {yMin, xMin,
    yMax, xMax} on a 0-1000 normalized scale (Gemini's own object-detection
    convention), (0,0) = top-left of the page.

    Returns JPEG bytes, or None if there's nothing to crop (missing/
    degenerate box, unsupported source, or any decoding/rendering error)
    -- callers fall back to linking the full page, exactly like before
    cropping existed."""
    if not region:
        return None
    try:
        y_min, x_min, y_max, x_max = (region.get(k) for k in ("yMin", "xMin", "yMax", "xMax"))
        if None in (y_min, x_min, y_max, x_max):
            return None
        img = _render_source_to_image(file_bytes, mime_type, pdf_page_index)
        if img is None:
            return None
        w, h = img.size
        left = max(0, min(w, round(x_min / 1000 * w)))
        right = max(0, min(w, round(x_max / 1000 * w)))
        top = max(0, min(h, round(y_min / 1000 * h)))
        bottom = max(0, min(h, round(y_max / 1000 * h)))
        if right - left < 10 or bottom - top < 10:
            return None  # degenerate box -- not worth keeping
        # Small margin so the crop isn't razor-tight on the figure's edge.
        pad_x, pad_y = round((right - left) * 0.08), round((bottom - top) * 0.08)
        left, right = max(0, left - pad_x), min(w, right + pad_x)
        top, bottom = max(0, top - pad_y), min(h, bottom + pad_y)
        out = io.BytesIO()
        img.crop((left, top, right, bottom)).save(out, format="JPEG", quality=85)
        return out.getvalue()
    except Exception:
        return None  # best-effort only -- a bad crop must never block saving the question


def _mark_batch_failed(db, batch_id, storage_path, error_text):
    if not batch_id:
        return
    try:
        db.collection("uploadBatches").document(batch_id).update({
            "processedPages": firestore.Increment(1),
            "failedPages": firestore.Increment(1),
            "lastError": (f"{storage_path}: {error_text}")[:500],
        })
    except Exception:
        pass  # best-effort progress tracking only -- never let this mask the real error


def _require_admin(db, req: https_fn.CallableRequest):
    """Raises if the caller isn't signed in and marked role=='admin' in
    their user doc -- the same check the existing Firestore rules use for
    parent-only writes (children, settings, etc.). Keeps the Student/Parent
    UI toggle purely cosmetic: this is the real authorization boundary."""
    if req.auth is None:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    user_doc = db.collection("users").document(req.auth.uid).get()
    if not user_doc.exists or user_doc.to_dict().get("role") != "admin":
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.PERMISSION_DENIED, "Parent/admin access required.")


@storage_fn.on_object_finalized(
    secrets=[GEMINI_API_KEY],
    timeout_sec=180,
    region="us-east1",
    memory=options.MemoryOption.MB_512,
)
def process_exam_page(event: storage_fn.CloudEvent) -> None:
    """Fires automatically whenever a file is uploaded under examPages/.
    Reads the scanned page, asks Gemini to generate practice questions (each
    tagged with a provisional skill name), and writes them to Firestore in
    the background. If the upload is tied to a chapter, also folds any new
    skill names into that chapter's skillSuggestions list for the parent to
    review on the Chapter Setup screen."""
    data = event.data
    storage_path = data.name
    if not storage_path or not storage_path.startswith("examPages/"):
        return  # not a page upload we care about

    parts = storage_path.split("/")
    if len(parts) < 3:
        return
    child_id = parts[1]

    metadata = data.metadata or {}
    subject_hint = metadata.get("subjectHint", "")
    chapter = metadata.get("chapter", "")
    chapter_id = metadata.get("chapterId") or None
    book_id = metadata.get("bookId") or None
    batch_id = metadata.get("batchId")
    uploaded_by = metadata.get("uploadedBy", "")
    page_index = metadata.get("pageIndex")
    page_count = metadata.get("pageCount")
    source_file_name = metadata.get("fileName", "")

    db = get_db()

    # Pull the chapter's existing skill vocabulary (confirmed skills + any
    # suggestions not yet reviewed) so this page's Gemini call reuses the
    # same names instead of inventing its own phrasing in isolation -- the
    # root cause of large duplicate-heavy skill lists on multi-page uploads.
    existing_skill_names = []
    if chapter_id:
        try:
            existing_skill_names = [
                d.to_dict().get("name", "") for d in db.collection("skills").where("chapterId", "==", chapter_id).stream()
                if not d.to_dict().get("mergedInto")
            ]
            chapter_snap = db.collection("chapters").document(chapter_id).get()
            if chapter_snap.exists:
                existing_skill_names += chapter_snap.to_dict().get("skillSuggestions", [])
            existing_skill_names = sorted(set(n for n in existing_skill_names if n))[:40]
        except Exception:
            existing_skill_names = []  # best-effort only -- never block generation on this

    try:
        blob = storage.bucket(data.bucket).blob(storage_path)
        file_bytes = blob.download_as_bytes()
        mime_type = data.content_type or _guess_mime_type(storage_path)

        client = genai.Client(api_key=GEMINI_API_KEY.value)

        skill_vocab_block = ""
        if existing_skill_names:
            skill_vocab_block = (
                "\n\nThis chapter already has these skill names in use. If a question matches one of "
                "these, reuse the name EXACTLY as written below (same spelling, same wording). Only "
                "write a new skillName if the question genuinely doesn't match any of these:\n"
                + "\n".join(f"- {n}" for n in existing_skill_names)
            )

        prompt = f"""You are helping a parent create practice questions from a scanned textbook page (a single image, or a PDF that may contain one or more scanned pages) for their 5th grader{f' (subject: {subject_hint})' if subject_hint else ''}{f', part of {chapter}' if chapter else ''}.

Read all the content provided, then write exactly 8 multiple-choice questions testing understanding of it: 2 "Simple" (direct recall), 2 "Medium" (connecting two facts), 2 "Hard" (applying or explaining why), 2 "Complex" (reasoning across multiple ideas).

For each question, also decide:
- "requiresImage": true only if the question genuinely cannot be answered from text alone -- e.g. "label the diagram", "what does the chart show", "identify the part shown in the picture". Set it false for ordinary questions, even if the page happens to contain a picture somewhere.
- "imageRegion": ONLY when requiresImage is true -- the bounding box of the SPECIFIC diagram/chart/picture this question refers to (not the whole page), as {{"yMin":0,"xMin":0,"yMax":1000,"xMax":1000}} on a 0-1000 normalized scale where (0,0) is the page's top-left corner and (1000,1000) is its bottom-right corner. Draw it tight around just that figure. When requiresImage is false, set imageRegion to null.
- "pdfPageIndex": ONLY relevant when the source file is a PDF and requiresImage is true -- the 0-based index of the PDF page the imageRegion box is on (0 = first page). If the source is a single image (not a PDF), or requiresImage is false, set this to null.
- "skillName": a short, concrete, learnable skill phrase this question practices, written the way a teacher would name it on a skills list -- e.g. "Multiply multi-digit whole numbers", "Identify the subject of a sentence", "Estimate products". Not a broad topic like "Multiplication" and not the question restated -- a specific, practiceable skill. Use the SAME skillName text for different questions that practice the same skill.{skill_vocab_block}

Return ONLY valid JSON, no markdown fences, no commentary:
{{
  "topic": "short topic name",
  "subject": "Science | Math | English | Social Studies | Other",
  "questions": [
    {{ "difficulty": "Simple", "question": "...", "options": ["...","...","...","..."], "correctIndex": 0, "explanation": "one sentence", "requiresImage": false, "imageRegion": null, "pdfPageIndex": null, "skillName": "..." }}
  ]
}}"""

        response = _generate_with_retry(
            client,
            model="gemini-3.8-flash",
            contents=[prompt, types.Part.from_bytes(data=file_bytes, mime_type=mime_type)],
        )
        raw = re.sub(r"^```json\s*|\s*```$", "", response.text.strip())
        parsed = json.loads(raw)
    except Exception as e:
        _mark_batch_failed(db, batch_id, storage_path, f"{type(e).__name__}: {e}")
        return

    try:
        batch = db.batch()
        count = 0
        skill_names = set()
        for q in parsed.get("questions", []):
            ref = db.collection("examQuestions").document()
            skill_name = (q.get("skillName") or "").strip()
            if skill_name:
                skill_names.add(skill_name)

            # If this question points at a specific figure, crop just that
            # region out of the page and store it alongside the question --
            # so the question can show the actual picture inline instead of
            # only a link to the whole scanned page. Best-effort: any
            # failure here just means no cropped image, never a lost question.
            cropped_image_path = None
            if q.get("requiresImage"):
                cropped_bytes = _crop_image_region(file_bytes, mime_type, q.get("imageRegion"), q.get("pdfPageIndex"))
                if cropped_bytes:
                    candidate_path = f"examPages/{child_id}/crops/{ref.id}.jpg"
                    try:
                        storage.bucket(data.bucket).blob(candidate_path).upload_from_string(
                            cropped_bytes, content_type="image/jpeg"
                        )
                        cropped_image_path = candidate_path
                    except Exception:
                        cropped_image_path = None

            doc = {
                "childId": child_id,
                "subject": parsed.get("subject", "Other"),
                "topic": parsed.get("topic", "Untitled"),
                "chapter": chapter,
                "chapterId": chapter_id,
                "bookId": book_id,
                "difficulty": q.get("difficulty") if q.get("difficulty") in DIFFICULTIES else "Medium",
                "question": q.get("question"),
                "options": q.get("options"),
                "correctIndex": q.get("correctIndex"),
                "explanation": q.get("explanation", ""),
                "requiresImage": bool(q.get("requiresImage", False)),
                "skillName": skill_name,
                "skillId": None,  # filled in once the parent confirms chapter skills
                "sourceImage": storage_path,
                "croppedImage": cropped_image_path,
                "pageNumber": int(page_index) if page_index and page_index.isdigit() else None,
                "pageCount": int(page_count) if page_count and page_count.isdigit() else None,
                "sourceFileName": source_file_name,
                "generatedBy": "ai",  # every question today comes from the Gemini pipeline
                "createdAt": firestore.SERVER_TIMESTAMP,
                "createdBy": uploaded_by,
            }
            batch.set(ref, doc)
            count += 1
        batch.commit()

        if batch_id:
            db.collection("uploadBatches").document(batch_id).update({
                "processedPages": firestore.Increment(1),
                "questionsGenerated": firestore.Increment(count),
            })
        if chapter_id and skill_names:
            db.collection("chapters").document(chapter_id).update({
                "skillSuggestions": firestore.ArrayUnion(sorted(skill_names)),
            })
    except Exception as e:
        _mark_batch_failed(db, batch_id, storage_path, f"write failed: {type(e).__name__}: {e}")


@https_fn.on_call(timeout_sec=60)
def confirm_chapter_skills(req: https_fn.CallableRequest):
    """Parent confirms/edits the AI-suggested skill list for a chapter.
    Creates the chapter's skills docs, then retags every existing question
    in that chapter whose skillName matches one of the confirmed names
    (case-insensitive) with the new skillId. Questions that don't match any
    confirmed skill are left with skillId=null -- not forced into a guess."""
    db = get_db()
    _require_admin(db, req)

    chapter_id = req.data.get("chapterId")
    skill_names = [s.strip() for s in (req.data.get("skills") or []) if s and s.strip()]
    if not chapter_id or not skill_names:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "chapterId and at least one skill are required.")

    chapter_ref = db.collection("chapters").document(chapter_id)
    chapter_snap = chapter_ref.get()
    if not chapter_snap.exists:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.NOT_FOUND, "Chapter not found.")
    chapter = chapter_snap.to_dict()

    # Create (or reuse, if confirming again after an edit) the skill docs.
    existing_skills = {
        d.to_dict().get("name", "").strip().lower(): d.id
        for d in db.collection("skills").where("chapterId", "==", chapter_id).stream()
    }
    name_to_id = {}
    batch = db.batch()
    for i, name in enumerate(skill_names):
        key = name.lower()
        if key in existing_skills:
            name_to_id[key] = existing_skills[key]
            continue
        ref = db.collection("skills").document()
        batch.set(ref, {
            "chapterId": chapter_id,
            "childId": chapter.get("childId"),
            "name": name,
            "order": i,
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        name_to_id[key] = ref.id
    batch.commit()

    # Retag existing questions in this chapter by matching skillName -> skillId.
    tagged = 0
    q_batch = db.batch()
    q_ops = 0
    for doc in db.collection("examQuestions").where("chapterId", "==", chapter_id).stream():
        q = doc.to_dict()
        key = (q.get("skillName") or "").strip().lower()
        skill_id = name_to_id.get(key)
        if skill_id and q.get("skillId") != skill_id:
            q_batch.update(doc.reference, {"skillId": skill_id})
            tagged += 1
            q_ops += 1
            if q_ops >= 450:  # stay under Firestore's 500-op batch limit
                q_batch.commit()
                q_batch = db.batch()
                q_ops = 0
    if q_ops:
        q_batch.commit()

    chapter_ref.update({
        "skillsConfirmed": True,
        "skillSuggestions": [],
    })

    return {"skillCount": len(name_to_id), "taggedQuestionCount": tagged}


@https_fn.on_call(timeout_sec=120)
def merge_skills(req: https_fn.CallableRequest):
    """Parent-reviewed skill grouping/merge. Unlike confirm_chapter_skills
    (first-time bulk confirm), this handles re-grouping skills that already
    exist -- renaming, merging near-duplicates, or just confirming a single
    raw suggestion as its own skill.

    data.groups: [{ name, memberSkillIds: [existing skills doc ids],
                     memberRawNames: [unconfirmed examQuestions.skillName
                     strings not yet tied to a skill doc] }]

    For each group: one member's skillId becomes canonical (or a new skills
    doc is created if the group has none); every other member skill doc is
    marked mergedInto=<canonicalId> (never deleted, so nothing referencing
    it -- including past examSessions snapshots -- breaks); every matching
    examQuestions doc in the chapter is retagged to the canonical skill."""
    db = get_db()
    _require_admin(db, req)

    chapter_id = req.data.get("chapterId")
    groups = req.data.get("groups") or []
    if not chapter_id or not groups:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "chapterId and at least one group are required.")

    chapter_ref = db.collection("chapters").document(chapter_id)
    chapter_snap = chapter_ref.get()
    if not chapter_snap.exists:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.NOT_FOUND, "Chapter not found.")
    child_id = chapter_snap.to_dict().get("childId")

    # Single equality-only query (no composite index needed) -- everything
    # else below is filtered in Python against this one in-memory snapshot,
    # rather than chaining extra .where() clauses per group.
    question_docs = list(db.collection("examQuestions").where("chapterId", "==", chapter_id).stream())

    skill_count = 0
    tagged_total = 0
    q_batch = db.batch()
    q_ops = 0

    def queue_update(doc_ref, data):
        nonlocal q_batch, q_ops, tagged_total
        q_batch.update(doc_ref, data)
        q_ops += 1
        tagged_total += 1
        if q_ops >= 450:  # stay under Firestore's 500-op batch limit
            q_batch.commit()
            q_batch = db.batch()
            q_ops = 0

    for group in groups:
        name = (group.get("name") or "").strip()
        member_skill_ids = set(s for s in (group.get("memberSkillIds") or []) if s)
        member_raw_names = set(s.strip() for s in (group.get("memberRawNames") or []) if s and s.strip())
        if not name or (not member_skill_ids and not member_raw_names):
            continue

        if member_skill_ids:
            canonical_id = next(iter(member_skill_ids))
            db.collection("skills").document(canonical_id).update({"name": name})
            for old_id in member_skill_ids:
                if old_id != canonical_id:
                    db.collection("skills").document(old_id).update({"mergedInto": canonical_id})
        else:
            new_ref = db.collection("skills").document()
            new_ref.set({
                "chapterId": chapter_id,
                "childId": child_id,
                "name": name,
                "order": 0,
                "createdAt": firestore.SERVER_TIMESTAMP,
            })
            canonical_id = new_ref.id
        skill_count += 1

        for doc in question_docs:
            q = doc.to_dict()
            matches = (q.get("skillId") in member_skill_ids) or (not q.get("skillId") and q.get("skillName") in member_raw_names)
            if matches and (q.get("skillId") != canonical_id or q.get("skillName") != name):
                queue_update(doc.reference, {"skillId": canonical_id, "skillName": name})

    if q_ops:
        q_batch.commit()

    chapter_ref.update({"skillsConfirmed": True, "skillSuggestions": []})

    return {"skillCount": skill_count, "taggedQuestionCount": tagged_total}


VALID_ROLES = {"admin", "student", "viewer"}


@https_fn.on_call(timeout_sec=30)
def set_user_role(req: https_fn.CallableRequest):
    """Admin-only: assigns a role to another family member's account, and --
    for role='student' -- binds that account to exactly one child, so a
    student can only ever see their own data. This is the ONLY way a
    non-'viewer' role gets set: the Firestore rules let a user create their
    own profile as 'viewer' and nothing else, so self-escalation to
    admin/student isn't possible from the client.

    data: { uid, role: 'admin'|'student'|'viewer', studentChildId? }
    """
    db = get_db()
    _require_admin(db, req)

    target_uid = req.data.get("uid")
    role = req.data.get("role")
    student_child_id = req.data.get("studentChildId")

    if not target_uid or role not in VALID_ROLES:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            f"uid and a valid role ({', '.join(sorted(VALID_ROLES))}) are required.",
        )
    if role == "student" and not student_child_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "studentChildId is required when role is 'student'.",
        )
    if target_uid == req.auth.uid and role != "admin":
        # Guard against an admin locking themselves out of the app by
        # demoting their own only-admin account from this screen.
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            "You can't change your own role here -- ask another admin, or do it directly in the Firebase Console.",
        )

    user_ref = db.collection("users").document(target_uid)
    if not user_ref.get().exists:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.NOT_FOUND, "User not found.")

    if role == "student":
        child_snap = db.collection("children").document(student_child_id).get()
        if not child_snap.exists:
            raise https_fn.HttpsError(https_fn.FunctionsErrorCode.NOT_FOUND, "That child was not found.")
        user_ref.update({"role": "student", "studentChildId": student_child_id})
    else:
        user_ref.update({"role": role, "studentChildId": firestore.DELETE_FIELD})

    return {"ok": True}


@https_fn.on_call(secrets=[GEMINI_API_KEY], timeout_sec=60)
def generate_insights(req: https_fn.CallableRequest):
    db = get_db()
    if req.auth is None:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")

    session_id = req.data.get("sessionId")
    session_ref = db.collection("examSessions").document(session_id)
    session_snap = session_ref.get()
    if not session_snap.exists:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.NOT_FOUND, "Session not found.")
    session = session_snap.to_dict()

    client = genai.Client(api_key=GEMINI_API_KEY.value)

    missed = [a for a in session.get("answers", []) if not a.get("correct")]
    missed_lines = "\n".join(
        f'- [{m["difficulty"]}] {m["topic"]}: "{m["question"]}" - answered "{m["givenAnswer"]}", correct was "{m["correctAnswer"]}"'
        for m in missed
    ) or "They got everything right!"

    prompt = f"""A 5th grader just took a practice exam. Here's what they got wrong:
{missed_lines}

Score: {session.get('score')}/{session.get('total')}.

Write 3-5 short, encouraging, specific suggestions (one sentence each) for what to review next, for a parent helping their child study. Return ONLY a JSON array of strings."""

    response = _generate_with_retry(client, model="gemini-3.8-flash", contents=prompt)
    try:
        raw = re.sub(r"^```json\s*|\s*```$", "", response.text.strip())
        suggestions = json.loads(raw)
    except json.JSONDecodeError:
        suggestions = [response.text]

    session_ref.update({"suggestions": suggestions, "suggestionsGeneratedAt": firestore.SERVER_TIMESTAMP})
    return {"suggestions": suggestions}
