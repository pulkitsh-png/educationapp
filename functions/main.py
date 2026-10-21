import json
import re

from firebase_functions import https_fn
from firebase_functions.params import SecretParam
import firebase_admin
from firebase_admin import firestore, storage
from google import genai
from google.genai import types

firebase_admin.initialize_app()

_db = None
def get_db():
    global _db
    if _db is None:
        _db = firestore.client()
    return _db

GEMINI_API_KEY = SecretParam("GEMINI_API_KEY")
DIFFICULTIES = ["Simple", "Medium", "Hard", "Complex"]
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


@https_fn.on_call(secrets=[GEMINI_API_KEY], timeout_sec=120)
def generate_questions_from_image(req: https_fn.CallableRequest):
    db = get_db()
    if req.auth is None:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")

    storage_path = req.data.get("storagePath")
    child_id = req.data.get("childId")
    subject_hint = req.data.get("subjectHint")
    if not storage_path:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "storagePath is required.")

    caller_doc = db.collection("users").document(req.auth.uid).get()
    if not caller_doc.exists or caller_doc.to_dict().get("role") != "admin":
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.PERMISSION_DENIED, "Only admins can generate questions.")

        blob = storage.bucket().blob(storage_path)
        file_bytes = blob.download_as_bytes()
        blob.reload()
        mime_type = blob.content_type or _guess_mime_type(storage_path)

        client = genai.Client(api_key=GEMINI_API_KEY.value)

        prompt = f"""You are helping a parent create practice questions from a scanned textbook page (a single image, or a PDF that may contain one or more scanned pages) for their 5th grader{f' (subject: {subject_hint})' if subject_hint else ''}.

         Read all the content provided, then write exactly 8 multiple-choice questions testing understanding of it: 2 "Simple" (direct recall), 2 "Medium" (connecting two facts), 2 "Hard" (applying or explaining why), 2 "Complex" (reasoning across multiple ideas).

         Return ONLY valid JSON, no markdown fences, no commentary:
         {{
           "topic": "short topic name",
           "subject": "Science | Math | English | Social Studies | Other",
           "questions": [
             {{ "difficulty": "Simple", "question": "...", "options": ["...","...","...","..."], "correctIndex": 0, "explanation": "one sentence" }}
           ]
         }}"""

        response = client.models.generate_content(
             model="gemini-2.0-flash",
             contents=[prompt, types.Part.from_bytes(data=file_bytes, mime_type=mime_type)],
        )
    raw = re.sub(r"^```json\s*|\s*```$", "", response.text.strip())
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INTERNAL, "Could not parse AI response as JSON.")

    batch = db.batch()
    written = []
    for q in parsed.get("questions", []):
        ref = db.collection("examQuestions").document()
        doc = {
            "childId": child_id,
            "subject": parsed.get("subject", "Other"),
            "topic": parsed.get("topic", "Untitled"),
            "difficulty": q.get("difficulty") if q.get("difficulty") in DIFFICULTIES else "Medium",
            "question": q.get("question"),
            "options": q.get("options"),
            "correctIndex": q.get("correctIndex"),
            "explanation": q.get("explanation", ""),
            "sourceImage": storage_path,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "createdBy": req.auth.uid,
        }
        batch.set(ref, doc)
        written.append({"id": ref.id, **doc})
    batch.commit()

    return {"topic": parsed.get("topic"), "subject": parsed.get("subject"), "count": len(written), "questions": written}


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

    response = client.models.generate_content(model="gemini-2.0-flash", contents=prompt)
    try:
        raw = re.sub(r"^```json\s*|\s*```$", "", response.text.strip())
        suggestions = json.loads(raw)
    except json.JSONDecodeError:
        suggestions = [response.text]

    session_ref.update({"suggestions": suggestions, "suggestionsGeneratedAt": firestore.SERVER_TIMESTAMP})
    return {"suggestions": suggestions}
