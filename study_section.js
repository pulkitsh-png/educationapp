// ══════════════════════════════════════════════════════════════
//  STUDY & EXAM
//  (split out of index.html so this feature can be updated on its
//   own -- loaded via <script src="study_section.js"> after the
//   shared app helpers and before the rest of the inline script.)
// ══════════════════════════════════════════════════════════════
var studyView = 'home';
var studyMode = null; // 'parent' | 'student' -- UI-only, never an authorization boundary
var studyChildId = null;
var studyExamQuestions = [];
var studyExamAnswers = {};
var studyLastResult = null;
var studyBankQuestions = [];
var studyBusy = false;
var studyActiveBatch = null;
var studyBatchUnsub = null;
var studyImageUrlCache = {};
var studyPages = [];
var studyBooks = [];
var studyChapters = [];
var studyMetaLoadedFor = null;
var studyChapterId = null;
var studyChapterStats = {}; // chapterId -> { totalQuestions, questions, skills, skillsNoQuestions, unconfirmedNames }
var newChapterDraft = { bookId: '', newBookName: '', newBookSubject: '', newBookType: 'curriculum', title: '', testDate: '' };
var studyManageChapterId = null;
var studyManageGroups = [];
var studyManageBusy = false;
var studyQuickSetupOpen = false;
var FULL_LEVELS = ['Simple', 'Medium', 'Hard', 'Complex'];
var studyFullPool = null;
var studyFullProgression = [];
var studyFullCurrentQ = null;
var studyFullLevel = 1;
var studyFullAnswer = undefined;
var studyFullTarget = 45;
var studyFullBusy = false;
var studyTimerStartedAt = null; // Date.now() when the current exam/test started -- recorded, never enforced (no time limit)
var studyTimerHandle = null;

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function startStudyTimer() {
  stopStudyTimer();
  studyTimerStartedAt = Date.now();
  studyTimerHandle = setInterval(() => {
    const el = document.getElementById('study-timer');
    if (el) el.textContent = `⏱ ${formatElapsed(Date.now() - studyTimerStartedAt)}`;
  }, 1000);
}

function stopStudyTimer() {
  if (studyTimerHandle) { clearInterval(studyTimerHandle); studyTimerHandle = null; }
}

function elapsedStudySeconds() {
  return studyTimerStartedAt ? Math.round((Date.now() - studyTimerStartedAt) / 1000) : null;
}

function formatTimeTaken(sec) {
  if (sec === null || sec === undefined) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function ensureStudyMetaLoaded() {
  if (!studyChildId || studyMetaLoadedFor === studyChildId) return;
  studyMetaLoadedFor = studyChildId; // set before awaiting so we don't re-fire while in flight
  const [booksSnap, chaptersSnap] = await Promise.all([
    db.collection('books').where('childId', '==', studyChildId).get(),
    db.collection('chapters').where('childId', '==', studyChildId).get(),
  ]);
  studyBooks = booksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  studyChapters = chaptersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (studyChapterId && !studyChapters.find(c => c.id === studyChapterId)) studyChapterId = null;
  renderApp();
}

async function refreshChapter(chapterId) {
  const snap = await db.collection('chapters').doc(chapterId).get();
  if (!snap.exists) return;
  const updated = { id: snap.id, ...snap.data() };
  const idx = studyChapters.findIndex(c => c.id === chapterId);
  if (idx >= 0) studyChapters[idx] = updated; else studyChapters.push(updated);
  renderApp();
}

function getStudyBook(bookId) { return studyBooks.find(b => b.id === bookId); }
function getStudyChapter(chapterId) { return studyChapters.find(c => c.id === chapterId); }

function renderNewChapterView() {
  const d = newChapterDraft;
  const creatingNewBook = d.bookId === '__new__';
  return `
  <div class="card" style="padding:20px;max-width:620px">
    <button class="btn btn-secondary" onclick="studyView='home'; renderApp();">← Back</button>
    <h2>📂 New Chapter</h2>

    <div style="margin-top:14px">
      <label style="font-size:.85rem;color:#666;display:block;margin-bottom:4px">Book</label>
      <select style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd" onchange="newChapterDraft.bookId=this.value; renderApp();">
        <option value="" ${!d.bookId?'selected':''}>Choose a book…</option>
        ${studyBooks.map(b => `<option value="${b.id}" ${d.bookId===b.id?'selected':''}>${esc(b.title)} (${esc(b.subject)}${b.bookType==='accelerated'?' · accelerated':''})</option>`).join('')}
        <option value="__new__" ${creatingNewBook?'selected':''}>+ New book…</option>
      </select>
    </div>

    ${creatingNewBook ? `
      <div style="margin-top:12px;padding:12px;background:#f7faf8;border-radius:10px;border:1px solid #e0e8e3">
        <label style="font-size:.85rem;color:#666;display:block;margin-bottom:4px">Book name</label>
        <input type="text" value="${esc(d.newBookName)}" placeholder="e.g. Grade 5 Math" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd" oninput="newChapterDraft.newBookName=this.value">
        <label style="font-size:.85rem;color:#666;display:block;margin:10px 0 4px">Subject</label>
        <input type="text" value="${esc(d.newBookSubject)}" placeholder="e.g. Math" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd" oninput="newChapterDraft.newBookSubject=this.value">
        <label style="font-size:.85rem;color:#666;display:block;margin:10px 0 4px">Book type</label>
        <div style="display:flex;gap:16px">
          <label><input type="radio" name="bookType" value="curriculum" ${d.newBookType==='curriculum'?'checked':''} onclick="newChapterDraft.newBookType='curriculum'"> Grade-level curriculum</label>
          <label><input type="radio" name="bookType" value="accelerated" ${d.newBookType==='accelerated'?'checked':''} onclick="newChapterDraft.newBookType='accelerated'"> Accelerated enrichment</label>
        </div>
      </div>
    ` : ''}

    <label style="font-size:.85rem;color:#666;display:block;margin:14px 0 4px">Chapter title</label>
    <input type="text" value="${esc(d.title)}" placeholder="e.g. Multiplication" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd" oninput="newChapterDraft.title=this.value">

    <label style="font-size:.85rem;color:#666;display:block;margin:14px 0 4px">Test date (optional)</label>
    <input type="date" value="${esc(d.testDate)}" style="padding:8px;border-radius:8px;border:1px solid #ddd" oninput="newChapterDraft.testDate=this.value">

    <div style="margin-top:18px">
      <button class="btn" onclick="createChapter()" ${studyBusy?'disabled':''}>${studyBusy ? '⏳ Creating…' : '✅ Create Chapter'}</button>
    </div>
  </div>`;
}

async function createChapter() {
  const d = newChapterDraft;
  if (!studyChildId) { showToast('⚠️ Pick a child first.'); return; }
  if (!d.title.trim()) { showToast('⚠️ Give the chapter a title.'); return; }
  let bookId = d.bookId;
  if (bookId === '__new__') {
    if (!d.newBookName.trim()) { showToast('⚠️ Give the new book a name.'); return; }
    studyBusy = true; renderApp();
    try {
      const bookRef = await db.collection('books').add({
        childId: studyChildId,
        title: d.newBookName.trim(),
        subject: d.newBookSubject.trim() || 'Other',
        bookType: d.newBookType,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      bookId = bookRef.id;
      studyBooks.push({ id: bookId, childId: studyChildId, title: d.newBookName.trim(), subject: d.newBookSubject.trim() || 'Other', bookType: d.newBookType });
    } catch (e) {
      console.error(e); showToast('❌ ' + (e.message || 'Could not create book.')); studyBusy = false; renderApp(); return;
    }
  } else if (!bookId) {
    showToast('⚠️ Choose or create a book first.'); return;
  }

  studyBusy = true; renderApp();
  try {
    const chapterRef = await db.collection('chapters').add({
      childId: studyChildId,
      bookId,
      title: d.title.trim(),
      testDate: d.testDate || null,
      skillSuggestions: [],
      skillsConfirmed: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    studyChapters.push({ id: chapterRef.id, childId: studyChildId, bookId, title: d.title.trim(), testDate: d.testDate || null, skillSuggestions: [], skillsConfirmed: false });
    studyChapterId = chapterRef.id;
    newChapterDraft = { bookId: '', newBookName: '', newBookSubject: '', newBookType: 'curriculum', title: '', testDate: '' };
    studyView = 'home';
    showToast('✅ Chapter created.');
  } catch (e) {
    console.error(e); showToast('❌ ' + (e.message || 'Could not create chapter.'));
  } finally {
    studyBusy = false; renderApp();
  }
}

// ── Chapter readiness stats (questions available, skills, gaps) ──────────
async function loadChapterStats(chapterId) {
  // Queried by childId (not chapterId) and filtered to this chapter in JS --
  // keeps the Firestore security rule provable as "childId == my student's
  // childId" for a student account, without needing a get()-indirection rule.
  const [qSnap, skillsSnap] = await Promise.all([
    db.collection('examQuestions').where('childId', '==', studyChildId).get(),
    db.collection('skills').where('childId', '==', studyChildId).get(),
  ]);
  const questions = qSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(q => q.chapterId === chapterId);
  const skillDocs = skillsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => !s.mergedInto && s.chapterId === chapterId);
  const countsBySkillId = {};
  const countsByRawName = {};
  questions.forEach(q => {
    if (q.skillId) countsBySkillId[q.skillId] = (countsBySkillId[q.skillId] || 0) + 1;
    else if (q.skillName) countsByRawName[q.skillName] = (countsByRawName[q.skillName] || 0) + 1;
  });
  const skills = skillDocs.map(s => ({ ...s, questionCount: countsBySkillId[s.id] || 0 }));
  studyChapterStats[chapterId] = {
    totalQuestions: questions.length,
    questions,
    skills,
    skillsNoQuestions: skills.filter(s => s.questionCount === 0).length,
    unconfirmedNames: Object.keys(countsByRawName),
  };
  renderApp();
  return studyChapterStats[chapterId];
}

// ── Skill grouping (string-similarity clustering -- a starting suggestion, ──
//    never an automatic merge; the parent adjusts before saving) ──────────
function normalizeSkillTokens(name) {
  const stop = new Set(['a', 'an', 'the', 'to', 'of', 'by', 'in', 'on', 'and', 'or', 'for', 'with']);
  return new Set(
    (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t && !stop.has(t))
  );
}
function tokenSimilarity(aTokens, bTokens) {
  const inter = [...aTokens].filter(t => bTokens.has(t)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union ? inter / union : 0;
}
function clusterSkillNames(entries) {
  const groups = [];
  entries.forEach(entry => {
    const tokens = normalizeSkillTokens(entry.label);
    let best = null, bestScore = 0;
    for (const g of groups) {
      const score = tokenSimilarity(tokens, g.tokens);
      if (score > bestScore) { bestScore = score; best = g; }
    }
    if (best && bestScore >= 0.5) {
      best.members.push(entry);
      best.tokens = new Set([...best.tokens, ...tokens]);
    } else {
      groups.push({ tokens, members: [entry], name: entry.label });
    }
  });
  return groups;
}

async function openManageSkills(chapterId) {
  let stats = studyChapterStats[chapterId];
  if (!stats) stats = await loadChapterStats(chapterId);
  const entries = [
    ...stats.skills.map(s => ({ key: 's:' + s.id, label: s.name, questionCount: s.questionCount, skillId: s.id })),
    ...stats.unconfirmedNames.map(n => ({
      key: 'n:' + n, label: n, skillId: null, rawName: n,
      questionCount: stats.questions.filter(q => !q.skillId && q.skillName === n).length,
    })),
  ];
  const clusters = clusterSkillNames(entries);
  studyManageGroups = clusters.map((g, i) => ({ id: 'g' + i, name: g.name, members: g.members }));
  studyManageChapterId = chapterId;
  studyView = 'manageSkills';
  renderApp();
}

function splitSkillMember(gi, mi) {
  const member = studyManageGroups[gi].members.splice(mi, 1)[0];
  studyManageGroups.push({ id: 'g' + studyManageGroups.length + '-' + Date.now(), name: member.label, members: [member] });
  renderApp();
}

function renderManageSkillsView() {
  const chapter = getStudyChapter(studyManageChapterId);
  return `
  <div class="card" style="padding:20px;max-width:760px">
    <button class="btn btn-secondary" onclick="studyView='home'; renderApp();">← Back</button>
    <h2>🧩 Manage Skills${chapter ? ` — ${esc(chapter.title)}` : ''}</h2>
    <p style="color:#666">Grouped by how similar the names are — nothing is merged automatically. Rename a group, split out an item that doesn't belong, then save.</p>

    ${studyManageGroups.map((g, gi) => `
      <div style="margin-top:14px;padding:14px;border:1px solid #eee;border-radius:10px;${g.members.length > 1 ? 'background:#fff8ea;border-color:#fde3b8' : ''}">
        <input type="text" value="${esc(g.name)}" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-weight:600" oninput="studyManageGroups[${gi}].name=this.value">
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
          ${g.members.map((m, mi) => `
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:.85rem;padding:4px 8px;background:#fff;border-radius:6px;border:1px solid #f0f0f0">
              <span>${esc(m.label)} <span style="color:#999">(${m.questionCount} question${m.questionCount === 1 ? '' : 's'})</span></span>
              ${g.members.length > 1 ? `<button class="btn btn-secondary btn-sm" onclick="splitSkillMember(${gi},${mi})">Split out</button>` : ''}
            </div>`).join('')}
        </div>
      </div>`).join('') || '<p style="color:#999;margin-top:14px">Nothing to review — upload some pages first.</p>'}

    ${studyManageGroups.length ? `
      <div style="margin-top:18px">
        <button class="btn" onclick="saveManagedSkills()" ${studyManageBusy ? 'disabled' : ''}>${studyManageBusy ? '⏳ Saving…' : '✅ Save Groupings'}</button>
      </div>
    ` : ''}
  </div>`;
}

async function saveManagedSkills() {
  const groups = studyManageGroups.filter(g => g.members.length && g.name.trim());
  if (!groups.length) { showToast('⚠️ Nothing to save.'); return; }
  studyManageBusy = true; renderApp();
  try {
    const callable = fx.httpsCallable('merge_skills');
    const payload = {
      chapterId: studyManageChapterId,
      groups: groups.map(g => ({
        name: g.name.trim(),
        memberSkillIds: g.members.filter(m => m.skillId).map(m => m.skillId),
        memberRawNames: g.members.filter(m => !m.skillId).map(m => m.rawName),
      })),
    };
    const result = await callable(payload);
    delete studyChapterStats[studyManageChapterId];
    await loadChapterStats(studyManageChapterId);
    await refreshChapter(studyManageChapterId);
    showToast(`✅ ${result.data.skillCount} skill(s) saved — ${result.data.taggedQuestionCount} question(s) tagged.`);
    studyView = 'home';
  } catch (e) {
    console.error(e); showToast('❌ ' + (e.message || 'Could not save skills.'));
  } finally {
    studyManageBusy = false; renderApp();
  }
}

async function getPageImageUrl(path) {
  if (studyImageUrlCache[path]) return studyImageUrlCache[path];
  const url = await storage.ref(path).getDownloadURL();
  studyImageUrlCache[path] = url;
  return url;
}

function renderPageReference(q) {
  if (!q.requiresImage) return '';
  // Prefer the cropped figure (just the diagram this question is about) --
  // falls back to linking/showing the full scanned page for older questions
  // generated before cropping existed, or when the source was a PDF.
  if (q.croppedImage) {
    const cropUrl = studyImageUrlCache[q.croppedImage];
    if (cropUrl) {
      return `<div style="margin-bottom:10px"><img src="${cropUrl}" style="max-width:100%;max-height:280px;border-radius:8px;border:1px solid #ddd;display:block" alt="Figure for this question"></div>`;
    }
  }
  if (!q.sourceImage) return '';
  const url = studyImageUrlCache[q.sourceImage];
  if (!url) return '';
  if (q.sourceImage.toLowerCase().endsWith('.pdf')) {
    return `<div style="margin-bottom:10px"><a href="${url}" target="_blank" rel="noopener" class="btn btn-secondary">📄 View reference page</a></div>`;
  }
  return `<div style="margin-bottom:10px"><img src="${url}" style="max-width:100%;max-height:320px;border-radius:8px;border:1px solid #ddd;display:block" alt="Reference page"></div>`;
}

// Small indented trace line shown under every question wherever questions
// are reviewed: which question number, which scanned page it came from
// (so a parent can find the original page and check the picture against
// the question), and that it was AI-generated. Doesn't require the image
// to be prefetched -- "View source page" fetches its URL lazily on click.
function renderQuestionTrace(q, n, total) {
  const bits = [];
  if (n != null) bits.push(`Q${n}${total ? ' of ' + total : ''}`);
  if (q.pageNumber) bits.push(`Page ${q.pageNumber}${q.pageCount ? ' of ' + q.pageCount : ''}`);
  if (q.sourceFileName) bits.push(esc(q.sourceFileName));
  const path = q.sourceImage ? q.sourceImage.replace(/'/g, "\\'") : '';
  return `
    <div style="margin:2px 0 10px 12px;padding-left:10px;border-left:2px solid #eee;font-size:.74rem;color:#aaa;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      ${bits.length ? `<span>${bits.join(' · ')}</span>` : ''}
      ${path ? `<button type="button" style="font:inherit;color:#3b82f6;background:none;border:none;padding:0;cursor:pointer" onclick="openPageFullSize('${path}')">🖼️ View source page ↗</button>` : ''}
      <span>🤖 Generated by AI agent</span>
    </div>`;
}

async function prefetchExamImages(questions) {
  const paths = new Set();
  questions.forEach(q => {
    if (!q.requiresImage) return;
    if (q.croppedImage) paths.add(q.croppedImage);
    else if (q.sourceImage) paths.add(q.sourceImage); // fallback for pre-cropping questions
  });
  await Promise.all(Array.from(paths).map(p => getPageImageUrl(p).catch(() => {})));
}

var DIFF_COLORS = {
  Simple:  { bg: '#e8f8ee', fg: '#1a7f3c', border: '#bbf7d0' },
  Medium:  { bg: '#eaf2ff', fg: '#1d4ed8', border: '#c6dcff' },
  Hard:    { bg: '#fff4e5', fg: '#b45309', border: '#fde3b8' },
  Complex: { bg: '#fdeaea', fg: '#b91c1c', border: '#f8c9c9' },
};
function diffBadge(diff) {
  const c = DIFF_COLORS[diff] || DIFF_COLORS.Medium;
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:.72rem;font-weight:700;background:${c.bg};color:${c.fg};border:1px solid ${c.border}">${esc(diff)}</span>`;
}

function renderStudyTab() {
  if (!studyChildId && children.length) studyChildId = children[0].id;
  ensureStudyMetaLoaded(); // fire-and-forget; re-renders itself once loaded
  switch (studyView) {
    case 'exam':         return renderExamView();
    case 'fullExam':      return renderFullExamView();
    case 'results':      return renderResultsView();
    case 'bank':         return renderBankView();
    case 'pages':        return renderPagesView();
    case 'newChapter':   return renderNewChapterView();
    case 'manageSkills': return renderManageSkillsView();
    case 'upload':       return renderUploadView();
    default:             return renderChapterHomeView();
  }
}

function childPicker() {
  return `<select onchange="studyChildId=this.value; studyChapterId=null; renderApp();" style="padding:8px;border-radius:8px;border:1px solid #ddd">
    ${children.map(c => `<option value="${c.id}" ${c.id===studyChildId?'selected':''}>${c.avatar||''} ${esc(c.name)}</option>`).join('')}
  </select>`;
}

function toggleQuickSetup() { studyQuickSetupOpen = !studyQuickSetupOpen; renderApp(); }

function renderChapterHomeView() {
  const childChapters = studyChapters.filter(c => c.childId === studyChildId);
  if (!studyChapterId || !childChapters.find(c => c.id === studyChapterId)) {
    studyChapterId = childChapters[0] ? childChapters[0].id : null;
  }
  const chapter = getStudyChapter(studyChapterId);
  const book = chapter ? getStudyBook(chapter.bookId) : null;
  const isAdmin = canEdit();
  if (!studyMode) studyMode = isAdmin ? 'parent' : 'student';

  if (chapter && !studyChapterStats[chapter.id]) loadChapterStats(chapter.id); // fire-and-forget
  const stats = chapter ? studyChapterStats[chapter.id] : null;

  const modeToggle = isAdmin ? `
    <div style="display:inline-flex;border:1px solid #ddd;border-radius:999px;overflow:hidden">
      <button onclick="studyMode='parent'; renderApp();" style="padding:6px 14px;border:none;background:${studyMode==='parent'?'#d4521a':'#fff'};color:${studyMode==='parent'?'#fff':'#555'};cursor:pointer;font-size:.82rem">👨‍👩‍👧 Parent</button>
      <button onclick="studyMode='student'; renderApp();" style="padding:6px 14px;border:none;background:${studyMode==='student'?'#d4521a':'#fff'};color:${studyMode==='student'?'#fff':'#555'};cursor:pointer;font-size:.82rem">🧒 Student</button>
    </div>` : '';

  const header = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px">
      <div>
        <h2 style="margin:0">${chapter ? esc(chapter.title) : '📚 Study & Exam'}</h2>
        ${chapter ? `<div style="color:#888;font-size:.88rem;margin-top:2px">${book ? esc(book.title) + ' · ' + esc(book.subject) : ''}${chapter.testDate ? ' · 🗓️ Test: ' + esc(chapter.testDate) : ''}</div>` : ''}
      </div>
      ${modeToggle}
    </div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0 18px">
      ${isStudentRole() ? '' : `<label style="font-size:.85rem;color:#666">${childPicker()}</label>`}
      ${childChapters.length ? `
        <select style="padding:6px 8px;border-radius:8px;border:1px solid #ddd" onchange="studyChapterId=this.value; renderApp();">
          ${childChapters.map(c => `<option value="${c.id}" ${c.id===studyChapterId?'selected':''}>${esc(c.title)}</option>`).join('')}
        </select>
      ` : ''}
      ${isAdmin && studyMode === 'parent' ? `<button class="btn btn-secondary btn-sm" onclick="studyView='newChapter'; renderApp();">+ New Chapter</button>` : ''}
    </div>`;

  if (!chapter) {
    return `<div class="card" style="padding:20px;max-width:760px">${header}
      <p style="color:#888">${isAdmin ? 'No chapters yet — create one and upload some pages to get started.' : 'No chapter has been set up yet — ask a parent to add material.'}</p>
      ${isAdmin ? `<button class="btn" onclick="studyView='newChapter'; renderApp();">+ New Chapter</button>` : ''}
    </div>`;
  }

  return studyMode === 'student'
    ? `<div class="card" style="padding:20px;max-width:760px">${header}${renderStudentChapterHome(chapter, stats)}</div>`
    : `<div class="card" style="padding:20px;max-width:900px">${header}${renderParentChapterHome(chapter, stats)}</div>`;
}

function renderParentChapterHome(chapter, stats) {
  const batch = studyActiveBatch && studyActiveBatch.chapterId === chapter.id ? studyActiveBatch : null;
  const processing = batch && batch.totalPages && (batch.processedPages || 0) < batch.totalPages;
  const unconfirmedCount = stats ? stats.unconfirmedNames.length : 0;
  const questionsAvailable = stats ? stats.totalQuestions : 0;
  const skillsConfirmedCount = stats ? stats.skills.length : 0;
  const skillsNoQuestions = stats ? stats.skillsNoQuestions : 0;

  let primary;
  if (processing) {
    primary = `<div style="padding:14px 16px;background:#eef6ff;border:1px solid #cfe3fb;border-radius:10px">
      ⏳ Processing uploads — ${batch.processedPages || 0} of ${batch.totalPages} page(s) done${batch.questionsGenerated ? `, ${batch.questionsGenerated} questions so far` : ''}.
    </div>`;
  } else if (unconfirmedCount > 0) {
    primary = `<button class="btn" style="font-size:1rem;padding:14px 22px" onclick="openManageSkills('${chapter.id}')">🧩 Review Skills (${unconfirmedCount})</button>`;
  } else if (!stats) {
    primary = `<div style="padding:14px 16px;background:#faf8f5;border:1px solid #eee;border-radius:10px;color:#888">Loading chapter status…</div>`;
  } else if (questionsAvailable === 0) {
    primary = `<button class="btn" style="font-size:1rem;padding:14px 22px" onclick="studyView='upload'; renderApp();">📷 Upload Pages</button>`;
  } else {
    primary = `<button class="btn" style="font-size:1rem;padding:14px 22px" onclick="startExamFromBank()">📝 Start Practice</button>`;
  }

  return `
    <div style="margin:14px 0 18px">${primary}</div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px;padding:14px;background:#faf8f5;border-radius:10px;border:1px solid #eee">
      <div><div style="font-size:1.4rem;font-weight:700">${questionsAvailable}</div><div style="font-size:.76rem;color:#888">Questions ready</div></div>
      <div><div style="font-size:1.4rem;font-weight:700">${skillsConfirmedCount}</div><div style="font-size:.76rem;color:#888">Skills confirmed</div></div>
      <div><div style="font-size:1.4rem;font-weight:700;color:${skillsNoQuestions ? '#b45309' : 'inherit'}">${skillsNoQuestions}</div><div style="font-size:.76rem;color:#888">Skills without questions</div></div>
      <div><div style="font-size:1.4rem;font-weight:700;color:${unconfirmedCount ? '#b45309' : 'inherit'}">${unconfirmedCount}</div><div style="font-size:.76rem;color:#888">Suggestions to review</div></div>
    </div>

    <div style="margin-top:18px">
      <div style="font-weight:700;color:#555;font-size:.8rem;letter-spacing:.03em;margin-bottom:8px">MATERIALS</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="studyView='upload'; renderApp();">📷 Upload / Processing</button>
        <button class="btn btn-secondary btn-sm" onclick="openPageGallery()">🖼️ Scanned Pages</button>
      </div>
    </div>

    <div style="margin-top:16px">
      <div style="font-weight:700;color:#555;font-size:.8rem;letter-spacing:.03em;margin-bottom:8px">CHAPTER SKILLS</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="openManageSkills('${chapter.id}')">🧩 Manage Skills${unconfirmedCount ? ` (${unconfirmedCount} new)` : ''}</button>
        <button class="btn btn-secondary btn-sm" onclick="openStudyBank()">📖 Question Bank</button>
      </div>
    </div>

    <div style="margin-top:16px">
      <div style="font-weight:700;color:#555;font-size:.8rem;letter-spacing:.03em;margin-bottom:8px">LEARNING ACTIVITY</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-secondary btn-sm" onclick="toggleQuickSetup()">📝 Quick Practice</button>
        ${studyQuickSetupOpen ? `
          <span style="font-size:.8rem;color:#666">Count:
            <select id="study-exam-count" style="padding:4px 6px;border-radius:6px;border:1px solid #ddd">
              ${[5,10,15,20,25].map(n => `<option value="${n}" ${n===10?'selected':''}>${n}</option>`).join('')}
            </select>
          </span>
          <button class="btn btn-sm" onclick="startExamFromBank()">Go</button>
        ` : ''}
        <button class="btn btn-secondary btn-sm" onclick="startRevisionExam()">🔁 Revise Weak Skills</button>
        <button class="btn btn-secondary btn-sm" onclick="startFullLengthTest()" ${studyFullBusy?'disabled':''}>${studyFullBusy ? '⏳ Preparing…' : '🎯 Full-Length Test (45, adaptive)'}</button>
      </div>
    </div>
  `;
}

function renderStudentChapterHome(chapter, stats) {
  const questionsAvailable = stats ? stats.totalQuestions : null;
  if (questionsAvailable === null) return `<p style="color:#888">Loading…</p>`;
  if (questionsAvailable === 0) return `<p style="color:#888">Nothing to practice yet for this chapter — check back once your parent adds some pages!</p>`;
  return `
    <div style="margin:14px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn" style="font-size:1.05rem;padding:16px 26px" onclick="toggleQuickSetup()">📝 Short Practice Test</button>
      ${studyQuickSetupOpen ? `
        <span style="font-size:.9rem;color:#666">Questions:
          <select id="study-exam-count" style="padding:6px 8px;border-radius:6px;border:1px solid #ddd;font-size:.9rem">
            ${[5,10,15,20,25].map(n => `<option value="${n}" ${n===10?'selected':''}>${n}</option>`).join('')}
          </select>
        </span>
        <button class="btn" onclick="startExamFromBank()">Start →</button>
      ` : ''}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-secondary" onclick="startRevisionExam()">🔁 Revise what felt tricky</button>
      <button class="btn btn-secondary" onclick="startFullLengthTest()" ${studyFullBusy?'disabled':''}>${studyFullBusy ? '⏳ Preparing…' : '🎯 Full-Length Test (45 questions)'}</button>
    </div>
    <div style="margin-top:10px;color:#aaa;font-size:.78rem">Nothing here is timed — we just quietly record how long each one takes, for your parent to see.</div>
  `;
}

function renderUploadView() {
  const chapter = getStudyChapter(studyChapterId);
  const batch = studyActiveBatch && studyActiveBatch.chapterId === studyChapterId ? studyActiveBatch : null;
  const pct = batch && batch.totalPages ? Math.round(100 * (batch.processedPages || 0) / batch.totalPages) : 0;
  const batchDone = batch && batch.totalPages && (batch.processedPages || 0) >= batch.totalPages;

  return `
  <div class="card" style="padding:20px;max-width:760px">
    <button class="btn btn-secondary" onclick="studyView='home'; renderApp();">← Back</button>
    <h2>📷 Materials${chapter ? ` — ${esc(chapter.title)}` : ''}</h2>

    ${canEdit() ? (chapter ? `
      <input id="study-file-input" type="file" multiple style="display:none" onchange="handleStudyFilesUpload(this)">
      <button class="btn" onclick="document.getElementById('study-file-input').click()" ${studyBusy?'disabled':''}>
        ${studyBusy ? '⏳ Uploading…' : '📷 Upload Pages & Generate Questions'}
      </button>
    ` : `<p style="color:#999">Pick a chapter from the home screen first.</p>`) : `<p style="color:#999">Only an admin can upload new pages.</p>`}

    ${batch ? `
      <div style="margin-top:20px;padding:16px;background:${batchDone ? '#f0faf3' : '#eef6ff'};border-radius:10px;border:1px solid ${batchDone ? '#c9ecd6' : '#cfe3fb'}">
        <strong>${batchDone ? '✅ Done' : '⏳ Generating questions in the background…'}</strong>
        <div style="margin-top:6px;color:#555">
          ${batch.processedPages || 0} of ${batch.totalPages} page(s) processed
          ${batch.failedPages ? ` — ${batch.failedPages} failed` : ''}
          ${batch.questionsGenerated ? ` — ${batch.questionsGenerated} questions generated so far` : ''}
        </div>
        <div style="margin-top:8px;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden">
          <div style="height:100%;background:${batchDone ? '#22c55e' : '#3b82f6'};width:${pct}%;transition:width .3s"></div>
        </div>
        ${batch.lastError ? `<div style="margin-top:8px;color:#b91c1c;font-size:.82rem">Last error: ${esc(batch.lastError)}</div>` : ''}
      </div>
    ` : ''}

    <div style="margin-top:20px">
      <button class="btn btn-secondary btn-sm" onclick="openPageGallery()">🖼️ View Scanned Pages</button>
    </div>
  </div>`;
}

async function openPageGallery() {
  if (!studyChildId) { showToast('⚠️ Pick a child first.'); return; }
  const snap = await db.collection('examQuestions').where('childId','==',studyChildId).get();
  const seen = {};
  snap.docs.forEach(d => {
    const q = d.data();
    if (!q.sourceImage || seen[q.sourceImage]) return;
    seen[q.sourceImage] = { path: q.sourceImage, topic: q.topic, chapter: q.chapter, subject: q.subject, url: null };
  });
  studyPages = Object.values(seen).sort((a,b) => (a.chapter||'').localeCompare(b.chapter||'') || (a.topic||'').localeCompare(b.topic||''));
  studyView = 'pages';
  renderApp();

  for (const p of studyPages) {
    if (p.path.toLowerCase().endsWith('.pdf')) continue;
    try { p.url = await getPageImageUrl(p.path); } catch (e) { p.url = null; }
    if (studyView === 'pages') renderApp();
  }
}

function renderPagesView() {
  return `
  <div class="card" style="padding:20px;max-width:960px">
    <button class="btn btn-secondary" onclick="studyView='home'; renderApp();">← Back</button>
    <h2>🖼️ Scanned Pages <span style="font-weight:400;color:#888;font-size:1rem">(${studyPages.length})</span></h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-top:16px">
      ${studyPages.map(p => {
        const isPdf = p.path.toLowerCase().endsWith('.pdf');
        return `
        <div style="border:1px solid #eee;border-radius:10px;overflow:hidden;background:#fafafa">
          ${isPdf ? `
            <a href="${p.path}" onclick="return false" style="display:flex;height:120px;align-items:center;justify-content:center;font-size:2.2rem;background:#f1f1f1;text-decoration:none">📄</a>
          ` : p.url ? `
            <img src="${p.url}" style="width:100%;height:120px;object-fit:cover;display:block" loading="lazy">
          ` : `<div style="height:120px;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:.8rem">Loading…</div>`}
          <div style="padding:8px">
            <div style="font-weight:600;font-size:.85rem">${esc(p.topic || 'Untitled')}</div>
            ${p.chapter ? `<div style="color:#999;font-size:.75rem">${esc(p.chapter)}</div>` : ''}
            <button class="btn btn-secondary btn-sm" style="margin-top:6px;width:100%" onclick="openPageFullSize('${p.path.replace(/'/g,"\\'")}')">Open full size ↗</button>
          </div>
        </div>`;
      }).join('') || '<p style="color:#999">No scanned pages yet.</p>'}
    </div>
  </div>`;
}

async function openPageFullSize(path) {
  try {
    const url = await getPageImageUrl(path);
    window.open(url, '_blank', 'noopener');
  } catch (e) {
    showToast('⚠️ Could not open page.');
  }
}

async function handleStudyFilesUpload(input) {
  const files = Array.from((input && input.files) || []);
  if (!files.length) return;
  if (!studyChildId) { showToast('⚠️ Pick a child first.'); return; }
  if (!studyChapterId) { showToast('⚠️ Pick or create a chapter first.'); return; }

  const chapterObj = getStudyChapter(studyChapterId);
  const bookObj = chapterObj ? getStudyBook(chapterObj.bookId) : null;
  const chapter = chapterObj ? chapterObj.title : '';
  const subjectHint = bookObj ? bookObj.subject : '';

  studyBusy = true; renderApp();
  try {
    const batchRef = db.collection('uploadBatches').doc();
    await batchRef.set({
      childId: studyChildId,
      chapter,
      chapterId: studyChapterId,
      bookId: chapterObj ? chapterObj.bookId : null,
      totalPages: files.length,
      processedPages: 0,
      failedPages: 0,
      questionsGenerated: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    watchUploadBatch(batchRef.id, studyChapterId);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = `examPages/${studyChildId}/${Date.now()}-${Math.random().toString(36).slice(2)}-${file.name}`;
      await storage.ref().child(path).put(file, {
        customMetadata: {
          childId: studyChildId,
          subjectHint,
          chapter,
          chapterId: studyChapterId,
          bookId: chapterObj ? chapterObj.bookId : '',
          batchId: batchRef.id,
          uploadedBy: currentUser ? currentUser.uid : '',
          // Lets each generated question point back to exactly which upload
          // this came from, so a parent/student can trace it to the
          // original page -- shown as "Page N of M" during review.
          pageIndex: String(i + 1),
          pageCount: String(files.length),
          fileName: file.name,
        },
      });
    }
    showToast(`📤 Uploaded ${files.length} page(s). Generating questions in the background — this can take a few minutes.`);
    input.value = '';
  } catch (e) {
    console.error(e);
    showToast('❌ ' + (e.message || 'Upload failed.'));
  } finally {
    studyBusy = false;
    renderApp();
  }
}

function watchUploadBatch(batchId, chapterId) {
  if (studyBatchUnsub) studyBatchUnsub();
  let wasDone = false;
  studyBatchUnsub = db.collection('uploadBatches').doc(batchId).onSnapshot(snap => {
    studyActiveBatch = snap.exists ? snap.data() : null;
    const b = studyActiveBatch;
    const nowDone = b && b.totalPages && (b.processedPages || 0) >= b.totalPages;
    if (nowDone && !wasDone && (chapterId || (b && b.chapterId))) {
      wasDone = true;
      refreshChapter(chapterId || b.chapterId);
    }
    if (document.getElementById('app')) renderApp();
  });
}

async function openStudyBank() {
  if (!studyChildId) { showToast('⚠️ Pick a child first.'); return; }
  if (!studyChapterId) { showToast('⚠️ Pick a chapter first.'); return; }
  const snap = await db.collection('examQuestions').where('childId','==',studyChildId).get();
  studyBankQuestions = snap.docs.map(d => ({id:d.id, ...d.data()})).filter(q => q.chapterId === studyChapterId);
  studyView = 'bank';
  renderApp();
  prefetchExamImages(studyBankQuestions).then(() => { if (studyView === 'bank') renderApp(); });
}

function renderBankView() {
  const byDiff = {Simple:[],Medium:[],Hard:[],Complex:[]};
  studyBankQuestions.forEach(q => { (byDiff[q.difficulty]||byDiff.Medium).push(q); });
  const byChapter = {};
  studyBankQuestions.forEach(q => {
    const key = q.chapter || '(No chapter tag)';
    (byChapter[key] = byChapter[key] || []).push(q);
  });

  return `
  <div class="card" style="padding:20px;max-width:960px">
    <button class="btn btn-secondary" onclick="studyView='home'; renderApp();">← Back</button>
    <h2>📖 Question Bank <span style="font-weight:400;color:#888;font-size:1rem">(${studyBankQuestions.length} questions)</span></h2>

    ${Object.keys(byChapter).length > 1 || (Object.keys(byChapter)[0] && byChapter[Object.keys(byChapter)[0]].length < studyBankQuestions.length) ? `
      <div style="margin:8px 0 16px;color:#666;font-size:.85rem">Chapters: ${Object.keys(byChapter).map(c => `${esc(c)} (${byChapter[c].length})`).join(' · ')}</div>
    ` : ''}

    ${Object.entries(byDiff).map(([diff, qs]) => qs.length ? `
      <div style="margin-top:22px;display:flex;align-items:center;gap:8px">
        ${diffBadge(diff)}<span style="color:#888;font-size:.85rem">${qs.length} question${qs.length===1?'':'s'}</span>
      </div>
      ${qs.map((q, qi) => `
        <div style="padding:14px;border:1px solid #eee;border-radius:10px;margin-top:8px">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
            <strong>${esc(q.topic)}</strong>
            ${q.chapter ? `<span style="color:#999;font-size:.78rem">${esc(q.chapter)}</span>` : ''}
          </div>
          <div style="margin-top:6px">${esc(q.question)}</div>
          ${renderPageReference(q)}
          <div style="color:#2d9e52;font-size:.85rem;margin-top:6px">✓ ${esc((q.options||[])[q.correctIndex] || '')}</div>
          ${renderQuestionTrace(q, qi + 1, qs.length)}
        </div>`).join('')}
    ` : '').join('') || '<p style="color:#999;margin-top:16px">No questions yet — upload a page first.</p>'}
  </div>`;
}

async function startExamFromBank() {
  if (!studyChildId) { showToast('⚠️ Pick a child first.'); return; }
  if (!studyChapterId) { showToast('⚠️ Pick a chapter first.'); return; }
  const count = parseInt(document.getElementById('study-exam-count')?.value || '10', 10);
  const snap = await db.collection('examQuestions').where('childId','==',studyChildId).get();
  const all = snap.docs.map(d => ({id:d.id, ...d.data()})).filter(q => q.chapterId === studyChapterId);
  if (!all.length) { showToast('⚠️ No questions yet for this chapter — upload a page first.'); return; }
  const shuffled = all.slice();
  for (let i = shuffled.length-1; i>0; i--) { const j = Math.floor(Math.random()*(i+1)); [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]; }
  studyExamQuestions = shuffled.slice(0, count);
  studyExamAnswers = {};
  await prefetchExamImages(studyExamQuestions);
  studyView = 'exam';
  startStudyTimer();
  renderApp();
}

async function startRevisionExam() {
  if (!studyChildId) { showToast('⚠️ Pick a child first.'); return; }
  if (!studyChapterId) { showToast('⚠️ Pick a chapter first.'); return; }
  const count = parseInt(document.getElementById('study-exam-count')?.value || '10', 10);

  const qSnap = await db.collection('examQuestions').where('childId','==',studyChildId).get();
  const all = qSnap.docs.map(d => ({id:d.id, ...d.data()})).filter(q => q.chapterId === studyChapterId);
  if (!all.length) { showToast('⚠️ No questions yet for this chapter — upload a page first.'); return; }

  const sessSnap = await db.collection('examSessions').where('childId','==',studyChildId).limit(30).get();
  const chapterQuestionIds = new Set(all.map(q => q.id));
  const missedByKey = {};
  sessSnap.docs.forEach(d => {
    (d.data().answers || []).forEach(a => {
      const key = a.skillName || a.topic;
      // Only count it as "weak" if it belongs to a question in THIS chapter's bank,
      // so revision for one book never pulls in a weak spot from another.
      if (!a.correct && key && chapterQuestionIds.has(a.questionId)) missedByKey[key] = (missedByKey[key] || 0) + 1;
    });
  });
  let weakKeys = Object.keys(missedByKey).sort((a,b) => missedByKey[b]-missedByKey[a]);
  if (!weakKeys.length) {
    // Fallback for older sessions saved before answers recorded questionId: match by skill/topic name only,
    // which is still scoped below because `all` is already this chapter's questions.
    sessSnap.docs.forEach(d => {
      (d.data().answers || []).forEach(a => {
        const key = a.skillName || a.topic;
        if (!a.correct && key) missedByKey[key] = (missedByKey[key] || 0) + 1;
      });
    });
    weakKeys = Object.keys(missedByKey).sort((a,b) => missedByKey[b]-missedByKey[a]);
  }
  if (!weakKeys.length) { showToast('No missed questions yet — take a practice exam first, then come back to revise!'); return; }

  const weakSet = new Set(weakKeys);
  const matchesWeak = q => weakSet.has(q.skillName) || weakSet.has(q.topic);
  let pool = all.filter(matchesWeak);
  if (pool.length < count) {
    const rest = all.filter(q => !matchesWeak(q));
    for (let i = rest.length-1; i>0; i--) { const j = Math.floor(Math.random()*(i+1)); [rest[i],rest[j]]=[rest[j],rest[i]]; }
    pool = pool.concat(rest.slice(0, count - pool.length));
  }
  for (let i = pool.length-1; i>0; i--) { const j = Math.floor(Math.random()*(i+1)); [pool[i],pool[j]]=[pool[j],pool[i]]; }
  studyExamQuestions = pool.slice(0, count);
  studyExamAnswers = {};
  await prefetchExamImages(studyExamQuestions);
  studyView = 'exam';
  startStudyTimer();
  showToast(`🔁 Revision focused on: ${weakKeys.slice(0,3).join(', ')}${weakKeys.length>3?'…':''}`);
  renderApp();
}

function renderExamView() {
  const total = studyExamQuestions.length;
  const answeredCount = Object.keys(studyExamAnswers).length;
  return `
  <div class="card" style="padding:20px;max-width:760px">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <h2 style="margin:0">📝 Practice Exam</h2>
      <span style="color:#666;font-size:.9rem">${answeredCount} of ${total} answered · <span id="study-timer" style="color:#999">⏱ ${formatElapsed(studyTimerStartedAt ? Date.now()-studyTimerStartedAt : 0)}</span></span>
    </div>
    <div style="margin-top:-6px;margin-bottom:10px;color:#aaa;font-size:.75rem">Not timed — this just records how long practice takes, for your parent's reference.</div>
    <div style="margin:10px 0 20px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden">
      <div style="height:100%;background:#3b82f6;width:${total ? Math.round(100*answeredCount/total) : 0}%;transition:width .2s"></div>
    </div>
    ${studyExamQuestions.map((q, i) => `
      <div style="margin-bottom:16px;padding:16px;border:1px solid #eee;border-radius:12px;background:${studyExamAnswers[i]!==undefined?'#fafcff':'#fff'}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
          <span style="color:#999;font-weight:700;font-size:.85rem">Question ${i+1} of ${total}</span>
          ${diffBadge(q.difficulty)}
        </div>
        ${renderPageReference(q)}
        <div style="font-weight:600;margin-bottom:6px">${esc(q.question)}</div>
        ${renderQuestionTrace(q, i + 1, total)}
        ${(q.options||[]).map((opt, oi) => `
          <label style="display:flex;align-items:center;gap:8px;padding:9px 12px;margin-bottom:6px;border-radius:8px;border:1px solid ${studyExamAnswers[i]===oi?'#3b82f6':'#e5e7eb'};background:${studyExamAnswers[i]===oi?'#eaf2ff':'#fff'};cursor:pointer">
            <input type="radio" name="q${i}" ${studyExamAnswers[i]===oi?'checked':''} onclick="studyExamAnswers[${i}]=${oi}; renderApp();">
            <span>${esc(opt)}</span>
          </label>`).join('')}
      </div>`).join('')}
    <div style="display:flex;gap:10px;margin-top:8px">
      <button class="btn" onclick="submitExam()">✅ Submit Exam</button>
      <button class="btn btn-secondary" onclick="stopStudyTimer(); studyView='home'; renderApp();">Cancel</button>
    </div>
  </div>`;
}

function startFullLengthTest() {
  if (!studyChildId) { showToast('⚠️ Pick a child first.'); return; }
  if (!studyChapterId) { showToast('⚠️ Pick a chapter first.'); return; }
  studyFullBusy = true; renderApp();
  db.collection('examQuestions').where('childId', '==', studyChildId).get().then(snap => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(q => q.chapterId === studyChapterId);
    if (all.length < 10) {
      studyFullBusy = false; renderApp();
      showToast(`⚠️ Only ${all.length} question(s) available for this chapter's full-length test — upload more pages across a mix of difficulties (aim for 20+) before trying this.`);
      return;
    }
    const pool = { Simple: [], Medium: [], Hard: [], Complex: [] };
    all.forEach(q => { (pool[q.difficulty] || pool.Medium).push(q); });
    studyFullPool = pool;
    studyFullProgression = [];
    studyFullLevel = 1; // start at Medium
    studyFullAnswer = undefined;
    const first = pickNextFullQuestion();
    studyFullBusy = false;
    if (!first) { showToast('⚠️ Not enough question variety to start a full-length test.'); renderApp(); return; }
    studyFullCurrentQ = first;
    studyView = 'fullExam';
    startStudyTimer();
    renderApp();
    prefetchExamImages([first]).then(() => { if (studyView === 'fullExam') renderApp(); });
  }).catch(e => {
    console.error(e); studyFullBusy = false; showToast('❌ Could not load questions.'); renderApp();
  });
}

function pickNextFullQuestion() {
  const tried = new Set();
  for (let radius = 0; radius < FULL_LEVELS.length; radius++) {
    const candidates = radius === 0 ? [studyFullLevel] : [studyFullLevel - radius, studyFullLevel + radius];
    for (const idx of candidates) {
      if (idx < 0 || idx >= FULL_LEVELS.length || tried.has(idx)) continue;
      tried.add(idx);
      const bucket = studyFullPool[FULL_LEVELS[idx]];
      if (bucket && bucket.length) {
        const pickIdx = Math.floor(Math.random() * bucket.length);
        const q = bucket.splice(pickIdx, 1)[0];
        studyFullLevel = idx;
        return q;
      }
    }
  }
  return null;
}

function renderFullProgressionTrack(progression) {
  if (!progression.length) return '';
  return `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
    ${progression.map(p => {
      const c = DIFF_COLORS[p.difficulty] || DIFF_COLORS.Medium;
      return `<div title="Q${p.n}: ${esc(p.difficulty)} — ${p.correct ? 'correct' : 'missed'}" style="width:14px;height:14px;border-radius:3px;background:${p.correct ? c.fg : '#fff'};border:2px solid ${c.fg}"></div>`;
    }).join('')}
  </div>`;
}

function renderFullExamView() {
  const q = studyFullCurrentQ;
  const n = studyFullProgression.length + 1;
  const total = studyFullTarget;
  if (!q) return `<div class="card" style="padding:20px"><p>Preparing…</p></div>`;
  return `
  <div class="card" style="padding:20px;max-width:760px">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <h2 style="margin:0">🎯 Full-Length Test</h2>
      <span style="color:#666;font-size:.9rem">Question ${n} of ${total} · <span id="study-timer" style="color:#999">⏱ ${formatElapsed(studyTimerStartedAt ? Date.now()-studyTimerStartedAt : 0)}</span></span>
    </div>
    <div style="margin-bottom:10px;color:#aaa;font-size:.75rem">Not timed — this just records how long the test takes, for your parent's reference.</div>
    <div style="margin:10px 0 14px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden">
      <div style="height:100%;background:#d4521a;width:${Math.round(100*(n-1)/total)}%;transition:width .2s"></div>
    </div>
    ${renderFullProgressionTrack(studyFullProgression)}
    <div style="padding:16px;border:1px solid #eee;border-radius:12px">
      <div style="margin-bottom:10px">${diffBadge(q.difficulty)}</div>
      ${renderPageReference(q)}
      <div style="font-weight:600;margin-bottom:6px">${esc(q.question)}</div>
      ${renderQuestionTrace(q, n, total)}
      ${(q.options||[]).map((opt, oi) => `
        <label style="display:flex;align-items:center;gap:8px;padding:9px 12px;margin-bottom:6px;border-radius:8px;border:1px solid ${studyFullAnswer===oi?'#3b82f6':'#e5e7eb'};background:${studyFullAnswer===oi?'#eaf2ff':'#fff'};cursor:pointer">
          <input type="radio" name="fullq" ${studyFullAnswer===oi?'checked':''} onclick="studyFullAnswer=${oi}; renderApp();">
          <span>${esc(opt)}</span>
        </label>`).join('')}
    </div>
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn" onclick="submitFullAnswer()" ${studyFullAnswer===undefined?'disabled':''}>${n>=total ? '✅ Finish Test' : 'Next Question →'}</button>
      <button class="btn btn-secondary" onclick="if(confirm('End this test early? What was answered so far will still be scored.')) finishFullTest();">End Test Early</button>
    </div>
  </div>`;
}

function submitFullAnswer() {
  const q = studyFullCurrentQ;
  if (studyFullAnswer === undefined || !q) return;
  const correct = studyFullAnswer === q.correctIndex;
  const difficultyIndex = FULL_LEVELS.indexOf(q.difficulty) >= 0 ? FULL_LEVELS.indexOf(q.difficulty) : 1;
  studyFullProgression.push({
    n: studyFullProgression.length + 1,
    questionId: q.id,
    topic: q.topic || '',
    skillId: q.skillId || null,
    skillName: q.skillName || '',
    sourceImage: q.sourceImage || null,
    croppedImage: q.croppedImage || null,
    requiresImage: !!q.requiresImage,
    pageNumber: q.pageNumber || null,
    pageCount: q.pageCount || null,
    sourceFileName: q.sourceFileName || '',
    difficulty: q.difficulty || 'Medium',
    difficultyIndex,
    question: q.question,
    givenAnswer: (q.options||[])[studyFullAnswer] ?? '(no answer)',
    correctAnswer: (q.options||[])[q.correctIndex] ?? '',
    correct,
  });

  studyFullLevel = correct ? Math.min(studyFullLevel + 1, FULL_LEVELS.length - 1) : Math.max(studyFullLevel - 1, 0);
  studyFullAnswer = undefined;

  if (studyFullProgression.length >= studyFullTarget) { finishFullTest(); return; }

  const next = pickNextFullQuestion();
  if (!next) { finishFullTest(); return; } // pool exhausted -- stop honestly rather than repeat questions
  studyFullCurrentQ = next;
  renderApp();
  prefetchExamImages([next]).then(() => { if (studyView === 'fullExam') renderApp(); });
}

async function finishFullTest() {
  const timeTakenSeconds = elapsedStudySeconds();
  stopStudyTimer();
  const progression = studyFullProgression;
  const total = progression.length;
  const score = progression.filter(p => p.correct).length;
  const weightedEarned = progression.reduce((s, p) => s + (p.correct ? p.difficultyIndex + 1 : 0), 0);
  const weightedMax = progression.reduce((s, p) => s + (p.difficultyIndex + 1), 0);
  const weightedScore = weightedMax ? Math.round(100 * weightedEarned / weightedMax) : 0;
  const highestIndex = progression.reduce((m, p) => p.correct ? Math.max(m, p.difficultyIndex) : m, -1);
  const highestDifficulty = highestIndex >= 0 ? FULL_LEVELS[highestIndex] : null;

  const answers = progression.map(p => ({
    topic: p.topic, difficulty: p.difficulty, question: p.question,
    givenAnswer: p.givenAnswer, correctAnswer: p.correctAnswer, correct: p.correct,
    skillId: p.skillId, skillName: p.skillName, questionId: p.questionId || null,
    sourceImage: p.sourceImage || null, croppedImage: p.croppedImage || null,
    requiresImage: !!p.requiresImage, pageNumber: p.pageNumber || null,
    pageCount: p.pageCount || null, sourceFileName: p.sourceFileName || '',
  }));

  const sessionRef = await db.collection('examSessions').add({
    childId: studyChildId, chapterId: studyChapterId, answers, score, total,
    testType: 'full',
    progression: progression.map(p => ({ n: p.n, difficulty: p.difficulty, difficultyIndex: p.difficultyIndex, correct: p.correct, topic: p.topic, skillId: p.skillId })),
    weightedScore, highestDifficulty, timeTakenSeconds,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  studyLastResult = { score, total, sessionId: sessionRef.id, suggestions: null, answers, testType: 'full', weightedScore, highestDifficulty, progression, timeTakenSeconds };
  studyFullPool = null; studyFullCurrentQ = null; studyFullProgression = [];
  studyView = 'results';
  renderApp();
  prefetchExamImages(answers).then(() => { if (studyView === 'results') renderApp(); });

  try {
    const callable = fx.httpsCallable('generate_insights');
    const result = await callable({ sessionId: sessionRef.id });
    studyLastResult.suggestions = result.data.suggestions;
    renderApp();
  } catch (e) {
    console.error(e);
  }
}

async function submitExam() {
  const timeTakenSeconds = elapsedStudySeconds();
  stopStudyTimer();
  const answers = studyExamQuestions.map((q, i) => {
    const givenIdx = studyExamAnswers[i];
    const correct = givenIdx === q.correctIndex;
    return {
      topic: q.topic || '', skillId: q.skillId || null, skillName: q.skillName || '',
      difficulty: q.difficulty || 'Medium', question: q.question, questionId: q.id || null,
      sourceImage: q.sourceImage || null, croppedImage: q.croppedImage || null,
      requiresImage: !!q.requiresImage, pageNumber: q.pageNumber || null,
      pageCount: q.pageCount || null, sourceFileName: q.sourceFileName || '',
      givenAnswer: (q.options||[])[givenIdx] ?? '(no answer)',
      correctAnswer: (q.options||[])[q.correctIndex] ?? '',
      correct
    };
  });
  const score = answers.filter(a => a.correct).length;
  const total = answers.length;

  const sessionRef = await db.collection('examSessions').add({
    childId: studyChildId, chapterId: studyChapterId, score, total, answers,
    timeTakenSeconds,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  studyLastResult = { score, total, sessionId: sessionRef.id, suggestions: null, answers, timeTakenSeconds };
  studyView = 'results';
  renderApp();
  prefetchExamImages(answers).then(() => { if (studyView === 'results') renderApp(); });

  try {
    const callable = fx.httpsCallable('generate_insights');
    const result = await callable({ sessionId: sessionRef.id });
    studyLastResult.suggestions = result.data.suggestions;
    renderApp();
  } catch (e) {
    console.error(e);
  }
}

function renderResultsView() {
  const r = studyLastResult;
  if (!r) return `<p>No results yet.</p>`;
  const pct = r.total ? Math.round(100 * r.score / r.total) : 0;
  const missed = (r.answers || []).filter(a => !a.correct);

  const byTopic = {};
  (r.answers || []).forEach(a => {
    const key = a.skillName || a.topic || '(untagged)';
    byTopic[key] = byTopic[key] || { correct: 0, total: 0 };
    byTopic[key].total++;
    if (a.correct) byTopic[key].correct++;
  });
  const topicRows = Object.entries(byTopic).sort((a, b) => (a[1].correct / a[1].total) - (b[1].correct / b[1].total));

  return `
  <div class="card" style="padding:20px;max-width:720px">
    <h2 style="margin-top:0">🎯 Results: ${r.score}/${r.total} <span style="color:#888;font-weight:400;font-size:1rem">(${pct}%)</span></h2>
    ${r.timeTakenSeconds != null ? `<div style="color:#999;font-size:.82rem;margin-top:-4px;margin-bottom:10px">⏱ Time taken: ${formatTimeTaken(r.timeTakenSeconds)} (not timed — recorded for reference only)</div>` : ''}

    ${r.testType === 'full' ? `
      <div style="margin:14px 0;padding:14px;background:#fef0eb;border:1px solid #fcd9c8;border-radius:10px">
        <strong>🎯 Full-Length Test Summary</strong>
        <div style="margin-top:6px;color:#555">
          Difficulty-weighted score: <strong>${r.weightedScore}%</strong> — harder questions answered correctly count for more, so this reflects how far Ivaan pushed, not just raw accuracy.
          ${r.highestDifficulty ? `<br>Highest difficulty answered correctly: ${diffBadge(r.highestDifficulty)}` : ''}
        </div>
        <div style="margin-top:10px">
          <div style="font-size:.8rem;color:#888;margin-bottom:4px">Difficulty progression, question by question:</div>
          ${renderFullProgressionTrack(r.progression || [])}
          <div style="font-size:.75rem;color:#aaa">Filled square = correct · outline only = missed · color = that question's difficulty level</div>
        </div>
      </div>
    ` : ''}

    ${topicRows.length > 1 ? `
      <div style="margin:14px 0">
        <strong>📊 Performance by skill</strong>
        ${topicRows.map(([topic, s]) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f0f0f0">
            <span>${esc(topic)}</span>
            <span style="color:${s.correct===s.total?'#2d9e52':s.correct===0?'#b91c1c':'#888'};font-weight:600">${s.correct}/${s.total}</span>
          </div>`).join('')}
      </div>
    ` : ''}

    ${missed.length ? `
      <div style="margin-top:14px">
        <strong style="color:#b91c1c">Missed questions:</strong>
        ${missed.map((a, ai) => `
          <div style="margin-top:8px;padding:10px 12px;border-radius:8px;background:#fdeaea;border:1px solid #f8c9c9">
            <div style="font-size:.85rem;color:#888">${diffBadge(a.difficulty)} <span style="margin-left:6px">${esc(a.topic)}</span></div>
            <div style="margin-top:4px">${esc(a.question)}</div>
            ${renderPageReference(a)}
            <div style="margin-top:4px;font-size:.88rem">You answered: <em>${esc(a.givenAnswer)}</em> — Correct: <strong>${esc(a.correctAnswer)}</strong></div>
            ${renderQuestionTrace(a, ai + 1, missed.length)}
          </div>`).join('')}
      </div>
    ` : `<p style="color:#2d9e52;margin-top:14px">🌟 Perfect score — no missed questions!</p>`}

    ${r.suggestions ? `
      <div style="margin-top:18px;padding:14px;background:#f7faf8;border-radius:10px;border:1px solid #e0e8e3">
        <strong>💡 Suggestions for next time:</strong>
        <ul style="margin:8px 0 0 18px">${r.suggestions.map(s => `<li style="margin-bottom:4px">${esc(s)}</li>`).join('')}</ul>
      </div>
    ` : `<p style="color:#888;margin-top:14px">⏳ Generating improvement suggestions…</p>`}

    <div style="display:flex;gap:10px;margin-top:18px">
      <button class="btn" onclick="studyView='home'; renderApp();">Done</button>
      <button class="btn btn-secondary" onclick="startRevisionExam()">🔁 Revise These Skills</button>
    </div>
  </div>`;
}
