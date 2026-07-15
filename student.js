/* =========================================================================
   STUDENT APP
   Sections: 1. Gate (join class)  2. State  3. Renderers
   4. Actions  5. Modals  6. Helpers  7. Event wiring  8. Init
   ========================================================================= */

/* --------------------------- 1. GATE --------------------------- */
const LS_CLASS_ID = 'classroom-hub-student-class-id';
const LS_STUDENT_NAME = 'classroom-hub-student-name';

async function initGate(){
  const savedId = localStorage.getItem(LS_CLASS_ID);
  const savedName = localStorage.getItem(LS_STUDENT_NAME);
  if(savedId && savedName){
    const doc = await db.collection('classes').doc(savedId).get();
    if(doc.exists){ startApp(savedId, doc.data(), savedName); return; }
    localStorage.removeItem(LS_CLASS_ID);
    localStorage.removeItem(LS_STUDENT_NAME);
  }
  showJoinGate();
}

function showJoinGate(){
  document.getElementById('gate').innerHTML = `
    <div class="gate-card">
      <div class="mark">CH</div>
      <h2>Join your class</h2>
      <p>Ask your teacher for the class join code.</p>
      <div class="field"><label>Class code</label><input id="g-code" class="mono" placeholder="e.g. K7P2QX" style="text-transform:uppercase;letter-spacing:.08em;"></div>
      <div class="field"><label>Your name</label><input id="g-name" placeholder="Full name"></div>
      <button class="btn primary" id="g-submit" style="width:100%;">Join class</button>
      <div class="gate-error" id="g-error"></div>
    </div>`;
  document.getElementById('g-submit').onclick = async ()=>{
    const code = document.getElementById('g-code').value.trim().toUpperCase();
    const name = document.getElementById('g-name').value.trim();
    const err = document.getElementById('g-error');
    if(!code || !name){ err.textContent = 'Fill in both fields to continue.'; return; }
    err.textContent = 'Looking up class…';
    try{
      const snap = await db.collection('classes').where('code','==',code).limit(1).get();
      if(snap.empty){ err.textContent = 'No class found with that code. Double-check with your teacher.'; return; }
      const doc = snap.docs[0];
      localStorage.setItem(LS_CLASS_ID, doc.id);
      localStorage.setItem(LS_STUDENT_NAME, name);
      startApp(doc.id, doc.data(), name);
    }catch(e){
      err.textContent = 'Could not reach the database. Check firebase-config.js is filled in correctly.';
    }
  };
}

/* --------------------------- 2. STATE --------------------------- */
let classId = null;
let classInfo = null;
let studentName = null;
let currentView = 'dashboard';
let assignments = [];
let announcements = [];
let quizzes = [];
let books = [];
let mySubmissions = {}; // assignmentId -> { text, submittedAt }
let myQuizResponses = {}; // quizId -> { studentName, answers: { questionId: { attempts:[], solved } } }
let selectedMcAnswer = {}; // "quizId-questionId" -> chosen option text (before submit)
let loaded = { assignments: false, announcements: false, quizzes: false, books: false };

function studentDocId(){
  // stable, readable doc id derived from the student's name
  return studentName.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-');
}

function startApp(id, info, name){
  classId = id; classInfo = info; studentName = name;
  document.getElementById('gate').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('class-name-display').textContent = info.className;
  document.getElementById('who-name').textContent = studentName;
  document.getElementById('who-avatar').textContent = initials(studentName);

  db.collection('classes').doc(classId).collection('assignments')
    .onSnapshot(async (snap)=>{
      assignments = snap.docs.map(d=>({ id:d.id, ...d.data() }));
      for(const a of assignments){
        const subDoc = await db.collection('classes').doc(classId).collection('assignments').doc(a.id)
          .collection('submissions').doc(studentDocId()).get();
        mySubmissions[a.id] = subDoc.exists ? subDoc.data() : null;
      }
      loaded.assignments = true;
      render();
      markSynced(true);
    }, ()=> markSynced(false));

  db.collection('classes').doc(classId).collection('announcements')
    .onSnapshot((snap)=>{
      announcements = snap.docs.map(d=>({ id:d.id, ...d.data() }));
      loaded.announcements = true;
      render();
      markSynced(true);
    }, ()=> markSynced(false));

  db.collection('classes').doc(classId).collection('quizzes')
    .onSnapshot(async (snap)=>{
      quizzes = snap.docs.map(d=>({ id:d.id, ...d.data() }));
      for(const q of quizzes){
        const respDoc = await db.collection('classes').doc(classId).collection('quizzes').doc(q.id)
          .collection('responses').doc(studentDocId()).get();
        myQuizResponses[q.id] = respDoc.exists ? respDoc.data() : { studentName, answers: {} };
      }
      loaded.quizzes = true;
      render();
      markSynced(true);
    }, ()=> markSynced(false));

  db.collection('classes').doc(classId).collection('books')
    .onSnapshot((snap)=>{
      books = snap.docs.map(d=>({ id:d.id, ...d.data() }))
        .sort((a,b)=> tsVal(b.createdAt)-tsVal(a.createdAt));
      loaded.books = true;
      render();
      markSynced(true);
    }, ()=> markSynced(false));
}

function markSynced(ok){
  const dot = document.getElementById('sync-dot');
  const label = document.getElementById('sync-label');
  if(ok){ dot.classList.remove('offline'); label.textContent = 'Live-synced with teacher'; }
  else{ dot.classList.add('offline'); label.textContent = 'Connection issue — check network'; }
}

/* --------------------------- 3. RENDERERS --------------------------- */
const viewRoot = document.getElementById('view-root');

function render(){
  document.querySelectorAll('.nav-btn').forEach(b=> b.classList.toggle('active', b.dataset.view === currentView));
  const renderers = { dashboard: renderDashboard, assignments: renderAssignments, announcements: renderAnnouncements, quizzes: renderQuizzes, books: renderBooks };
  (renderers[currentView] || renderDashboard)();
}

function setHeader(title, subtitle){
  document.getElementById('view-title').textContent = title;
  document.getElementById('view-subtitle').textContent = subtitle;
}

function renderDashboard(){
  setHeader('Dashboard', `What's due and what's new in ${classInfo.className}.`);
  const upcoming = [...assignments].sort((a,b)=> (a.dueDate||'').localeCompare(b.dueDate||'')).slice(0,3);
  const recentAnnouncement = [...announcements].sort((a,b)=> tsVal(b.postedAt)-tsVal(a.postedAt))[0];

  let html = `<div class="grid-2">`;
  html += `<div class="card"><h3>Upcoming assignments</h3>`;
  if(!loaded.assignments){ html += `<p class="meta">Loading…</p>`; }
  else if(upcoming.length === 0){ html += `<p class="meta">Nothing assigned yet.</p>`; }
  else{
    upcoming.forEach(a=>{
      const status = statusFor(a);
      html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:0.5px solid var(--line);">
        <div><div style="font-weight:600;font-size:13px;">${escapeHtml(a.title)}</div><div class="meta">Due ${a.dueDate}</div></div>
        <span class="stamp ${status.cls}">${status.label}</span>
      </div>`;
    });
  }
  html += `</div>`;

  html += `<div class="card"><h3>Latest announcement</h3>`;
  if(!loaded.announcements){ html += `<p class="meta">Loading…</p>`; }
  else if(!recentAnnouncement){ html += `<p class="meta">No announcements yet.</p>`; }
  else{
    html += `<div style="font-weight:600;font-size:13px;">${escapeHtml(recentAnnouncement.title)}</div>
      <p class="body-text">${escapeHtml(recentAnnouncement.body)}</p>
      <div class="meta">${timeAgo(tsVal(recentAnnouncement.postedAt))}</div>`;
  }
  html += `</div></div>`;
  viewRoot.innerHTML = html;
}

function renderAssignments(){
  setHeader('Assignments', 'View instructions and submit your work.');
  if(!loaded.assignments){
    viewRoot.innerHTML = `<div class="empty"><h3>Loading assignments…</h3><p>Connecting to your class.</p></div>`;
    return;
  }
  if(assignments.length === 0){
    viewRoot.innerHTML = `<div class="empty"><h3>No assignments yet</h3><p>Check back once your teacher posts an assignment.</p></div>`;
    return;
  }
  let html = '';
  [...assignments].sort((a,b)=> (a.dueDate||'').localeCompare(b.dueDate||'')).forEach(a=>{
    const status = statusFor(a);
    const sub = mySubmissions[a.id];
    html += `<div class="card">
      <div class="card-row">
        <div>
          <h3>${escapeHtml(a.title)}</h3>
          <div class="meta">Due ${a.dueDate}</div>
          <p class="body-text">${escapeHtml(a.instructions)}</p>
        </div>
        <span class="stamp ${status.cls}">${status.label}</span>
      </div>`;
    if(sub){
      html += `<div class="meta" style="margin-top:8px;">Submitted ${timeAgo(tsVal(sub.submittedAt))}: "${escapeHtml(sub.text)}"</div>
        <div class="form-actions"><button class="btn small" data-submit="${a.id}">Update submission</button></div>`;
    }else{
      html += `<div class="form-actions"><button class="btn primary small" data-submit="${a.id}">Submit work</button></div>`;
    }
    html += `</div>`;
  });
  viewRoot.innerHTML = html;
  viewRoot.querySelectorAll('[data-submit]').forEach(b=> b.onclick = ()=> openSubmitModal(b.dataset.submit));
}

function renderAnnouncements(){
  setHeader('Announcements', 'Updates from your teacher.');
  if(!loaded.announcements){
    viewRoot.innerHTML = `<div class="empty"><h3>Loading announcements…</h3><p>Connecting to your class.</p></div>`;
    return;
  }
  if(announcements.length === 0){
    viewRoot.innerHTML = `<div class="empty"><h3>No announcements yet</h3><p>Nothing posted yet — check back soon.</p></div>`;
    return;
  }
  let html = '';
  [...announcements].sort((a,b)=> tsVal(b.postedAt)-tsVal(a.postedAt)).forEach(n=>{
    html += `<div class="card">
      <h3>${escapeHtml(n.title)}</h3>
      <div class="meta">${timeAgo(tsVal(n.postedAt))}</div>
      <p class="body-text">${escapeHtml(n.body)}</p>
    </div>`;
  });
  viewRoot.innerHTML = html;
}

function renderBooks(){
  setHeader('Book', 'Read materials your teacher has posted.');
  if(!loaded.books){
    viewRoot.innerHTML = `<div class="empty"><h3>Loading books…</h3><p>Connecting to your class.</p></div>`;
    return;
  }
  if(books.length === 0){
    viewRoot.innerHTML = `<div class="empty"><h3>No book materials yet</h3><p>Check back once your teacher posts one.</p></div>`;
    return;
  }
  let html = '';
  books.forEach(b=>{
    html += `<div class="card">
      <div class="card-row">
        <div>
          <h3>${escapeHtml(b.title)}</h3>
          <div class="meta">${b.pageCount} page${b.pageCount===1?'':'s'}${b.toc && b.toc.length ? ` · ${b.toc.length} chapter${b.toc.length===1?'':'s'}` : ''}</div>
        </div>
      </div>
      <div class="form-actions"><button class="btn primary small" data-book-open="${b.id}">Open book</button></div>
    </div>`;
  });
  viewRoot.innerHTML = html;
  viewRoot.querySelectorAll('[data-book-open]').forEach(b=> b.onclick = ()=> openBookViewer(b.dataset.bookOpen));
}

function renderQuizzes(){
  setHeader('Quizzes', "Answer each question — you'll know right away if you got it right.");
  if(!loaded.quizzes){
    viewRoot.innerHTML = `<div class="empty"><h3>Loading quizzes…</h3><p>Connecting to your class.</p></div>`;
    return;
  }
  if(quizzes.length === 0){
    viewRoot.innerHTML = `<div class="empty"><h3>No quizzes yet</h3><p>Check back once your teacher posts one.</p></div>`;
    return;
  }
  let html = '';
  quizzes.forEach(quiz=>{
    html += `<div class="card"><h3>${escapeHtml(quiz.title)}</h3>`;
    quiz.questions.forEach((q, i)=>{ html += renderQuizQuestion(quiz.id, q, i); });
    html += `</div>`;
  });
  viewRoot.innerHTML = html;
  wireQuizHandlers();
}

function renderQuizQuestion(quizId, q, index){
  const resp = myQuizResponses[quizId] || { answers: {} };
  const ans = (resp.answers && resp.answers[q.id]) || { attempts: [], solved: false };
  const attemptsUsed = ans.attempts.length;
  const remaining = q.maxAttempts - attemptsUsed;
  const solved = !!ans.solved;
  const revealed = solved || remaining <= 0;

  let feedback = '';
  if(solved){
    feedback = `<div class="feedback correct">Correct! ✓</div>`;
  }else if(revealed){
    feedback = `<div class="feedback revealed">Out of attempts. Correct answer: ${escapeHtml(q.correctAnswer)}</div>`;
  }else if(attemptsUsed > 0){
    feedback = `<div class="feedback incorrect">Not quite — ${remaining} attempt${remaining === 1 ? '' : 's'} left</div>`;
  }

  let inputHtml = '';
  if(!revealed){
    if(q.type === 'mc'){
      inputHtml = q.options.map(o=> `<div class="quiz-opt" data-mc-opt data-quiz="${quizId}" data-question="${q.id}" data-value="${escapeHtml(o)}">${escapeHtml(o)}</div>`).join('');
      inputHtml += `<div class="form-actions"><button class="btn primary small" data-mc-submit data-quiz="${quizId}" data-question="${q.id}">Submit answer</button></div>`;
    }else{
      inputHtml = `<input data-text-answer data-quiz="${quizId}" data-question="${q.id}" placeholder="Your answer">
        <div class="form-actions"><button class="btn primary small" data-text-submit data-quiz="${quizId}" data-question="${q.id}">Submit answer</button></div>`;
    }
  }

  return `<div class="quiz-q">
    <div style="font-weight:600;font-size:13px;">${index + 1}. ${escapeHtml(q.questionText)}</div>
    ${q.imageUrl ? `<img src="${escapeHtml(q.imageUrl)}" alt="">` : ''}
    ${inputHtml}
    ${feedback}
  </div>`;
}

function wireQuizHandlers(){
  viewRoot.querySelectorAll('[data-mc-opt]').forEach(el=>{
    el.onclick = ()=>{
      const key = el.dataset.quiz + '-' + el.dataset.question;
      viewRoot.querySelectorAll(`[data-mc-opt][data-quiz="${el.dataset.quiz}"][data-question="${el.dataset.question}"]`)
        .forEach(o=> o.classList.remove('selected'));
      el.classList.add('selected');
      selectedMcAnswer[key] = el.dataset.value;
    };
  });
  viewRoot.querySelectorAll('[data-mc-submit]').forEach(btn=>{
    btn.onclick = ()=>{
      const key = btn.dataset.quiz + '-' + btn.dataset.question;
      const value = selectedMcAnswer[key];
      if(!value){ alert('Choose an option first.'); return; }
      submitQuizAnswer(btn.dataset.quiz, btn.dataset.question, value);
    };
  });
  viewRoot.querySelectorAll('[data-text-submit]').forEach(btn=>{
    btn.onclick = ()=>{
      const input = viewRoot.querySelector(`[data-text-answer][data-quiz="${btn.dataset.quiz}"][data-question="${btn.dataset.question}"]`);
      const value = input.value.trim();
      if(!value){ alert('Type an answer first.'); return; }
      submitQuizAnswer(btn.dataset.quiz, btn.dataset.question, value);
    };
  });
}

async function submitQuizAnswer(quizId, questionId, value){
  const quiz = quizzes.find(q=> q.id === quizId);
  const question = quiz.questions.find(q=> q.id === questionId);
  const resp = myQuizResponses[quizId] || { studentName, answers: {} };
  const ans = resp.answers[questionId] || { attempts: [], solved: false };

  if(ans.solved || ans.attempts.length >= question.maxAttempts) return;

  const isCorrect = question.type === 'mc'
    ? value === question.correctAnswer
    : value.trim().toLowerCase() === (question.correctAnswer || '').trim().toLowerCase();

  // snapshot for rollback in case the write fails
  const prevAttempts = [...ans.attempts];
  const prevSolved = ans.solved;

  ans.attempts.push({ value, correct: isCorrect, at: Date.now() });
  if(isCorrect) ans.solved = true;
  resp.answers[questionId] = ans;
  resp.studentName = studentName;
  myQuizResponses[quizId] = resp;
  render();

  try{
    await db.collection('classes').doc(classId).collection('quizzes').doc(quizId)
      .collection('responses').doc(studentDocId()).set(resp, { merge: true });
  }catch(e){
    // roll back the optimistic update so the UI matches what's actually saved
    ans.attempts = prevAttempts;
    ans.solved = prevSolved;
    resp.answers[questionId] = ans;
    myQuizResponses[quizId] = resp;
    render();
    alert("Couldn't save your answer — check your connection and try again.");
    return;
  }

  render();
}

/* --------------------------- 4. ACTIONS --------------------------- */
function statusFor(a){
  const overdue = a.dueDate && new Date(a.dueDate) < new Date(new Date().toDateString());
  const sub = mySubmissions[a.id];
  if(sub) return { cls:'submitted', label:'submitted' };
  if(overdue) return { cls:'overdue', label:'overdue' };
  return { cls:'assigned', label:'assigned' };
}

/* --------------------------- 5. MODALS --------------------------- */
function openModal(html, extraClass){
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal${extraClass ? ' ' + extraClass : ''}">${html}</div>`;
  bg.addEventListener('click', (e)=>{ if(e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  return bg;
}

function openSubmitModal(assignmentId){
  const a = assignments.find(x=>x.id===assignmentId);
  const existing = mySubmissions[assignmentId];
  const modal = openModal(`
    <h3>Submit: ${escapeHtml(a.title)}</h3>
    <div class="field"><label>Your response</label><textarea id="f-text" rows="4" placeholder="Paste your work or notes here">${existing ? escapeHtml(existing.text) : ''}</textarea></div>
    <div class="form-actions"><button class="btn" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">${existing ? 'Update' : 'Submit'}</button></div>
    <div class="gate-error" id="f-error"></div>
  `);
  modal.querySelector('#f-cancel').onclick = ()=> modal.remove();
  modal.querySelector('#f-save').onclick = async ()=>{
    const text = modal.querySelector('#f-text').value.trim();
    const saveBtn = modal.querySelector('#f-save');
    const err = modal.querySelector('#f-error');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    err.textContent = '';
    try{
      await db.collection('classes').doc(classId).collection('assignments').doc(assignmentId)
        .collection('submissions').doc(studentDocId()).set({
          studentName, text, submittedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      modal.remove();
    }catch(e){
      saveBtn.disabled = false;
      saveBtn.textContent = existing ? 'Update' : 'Submit';
      err.textContent = "Couldn't save — check your connection and try again.";
    }
  };
}

/* Full-screen book reader: table of contents, prev/next paging, zoom, and
   personal bookmarks with notes. */
async function openBookViewer(bookId){
  const book = books.find(b=> b.id === bookId);
  if(!book) return;
  const ownerId = studentDocId();
  const modal = openModal(`
    <div class="book-viewer-head"><h3 style="margin:0;">${escapeHtml(book.title)}</h3><button class="btn small" id="bv-close">Close</button></div>
    <div id="bv-body"><p class="meta">Loading pages…</p></div>
  `, 'book-modal');
  const keyHandler = (e)=>{
    if(!document.body.contains(modal)){ document.removeEventListener('keydown', keyHandler); return; }
    if(e.key === 'ArrowLeft') go(pageNum - 1);
    if(e.key === 'ArrowRight') go(pageNum + 1);
  };
  document.addEventListener('keydown', keyHandler);
  modal.querySelector('#bv-close').onclick = ()=>{ document.removeEventListener('keydown', keyHandler); modal.remove(); };

  const bookmarksRef = db.collection('classes').doc(classId).collection('books').doc(bookId).collection('bookmarks').doc(ownerId);
  const [pagesSnap, bmDoc] = await Promise.all([
    db.collection('classes').doc(classId).collection('books').doc(bookId).collection('pages').orderBy('index').get(),
    bookmarksRef.get()
  ]);
  const pages = pagesSnap.docs.map(d=> d.data());
  if(pages.length === 0){
    modal.querySelector('#bv-body').innerHTML = `<p class="meta">This book has no pages yet.</p>`;
    return;
  }

  let pageNum = 1, zoom = 1;
  let bookmarks = bmDoc.exists ? (bmDoc.data().items || []) : [];

  async function saveBookmarks(){
    try{
      await bookmarksRef.set({ items: bookmarks, studentName });
    }catch(e){
      alert("Couldn't save your bookmarks — check your connection and try again.");
    }
  }

  function openBookmarkEditor(page){
    const existing = bookmarks.find(b=> b.page === page);
    const mini = openModal(`
      <h3>${existing ? 'Edit' : 'Add'} bookmark — page ${page}</h3>
      <div class="field"><label>Note (optional)</label><textarea id="bm-note" rows="3" placeholder="What's here?">${existing ? escapeHtml(existing.note || '') : ''}</textarea></div>
      <div class="form-actions">
        ${existing ? '<button class="btn danger" id="bm-remove">Remove</button>' : ''}
        <button class="btn" id="bm-cancel">Cancel</button>
        <button class="btn primary" id="bm-save">${existing ? 'Save' : 'Add bookmark'}</button>
      </div>
    `);
    mini.querySelector('#bm-cancel').onclick = ()=> mini.remove();
    if(existing){
      mini.querySelector('#bm-remove').onclick = async ()=>{
        bookmarks = bookmarks.filter(b=> b.id !== existing.id);
        await saveBookmarks();
        mini.remove();
        renderBody();
      };
    }
    mini.querySelector('#bm-save').onclick = async ()=>{
      const note = mini.querySelector('#bm-note').value.trim();
      if(existing){ existing.note = note; }
      else{ bookmarks.push({ id: 'bm' + Math.random().toString(36).slice(2,9), page, note, createdAt: Date.now() }); }
      await saveBookmarks();
      mini.remove();
      renderBody();
    };
  }

  function go(n){ pageNum = Math.max(1, Math.min(pages.length, n)); renderBody(); }
  function setZoom(z){ zoom = Math.max(0.5, Math.min(3, Math.round(z*100)/100)); renderBody(); }

  function renderBody(){
    const toc = book.toc || [];
    const sortedBookmarks = [...bookmarks].sort((a,b)=> a.page - b.page);
    const isBookmarked = bookmarks.some(b=> b.page === pageNum);
    const body = modal.querySelector('#bv-body');
    body.innerHTML = `
      <div class="book-viewer">
        <div class="book-toc">
          <div class="meta" style="margin-bottom:8px;font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:.04em;">Contents</div>
          ${toc.length === 0 ? '<p class="book-empty-toc">No chapters added.</p>' : toc.map(t=> `<div class="book-toc-item" data-goto="${t.page}">${escapeHtml(t.title)}</div>`).join('')}
          <div class="meta" style="margin:16px 0 8px;font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:.04em;">My bookmarks</div>
          ${sortedBookmarks.length === 0 ? '<p class="book-empty-toc">No bookmarks yet.</p>' : sortedBookmarks.map(bm=> `
            <div class="book-toc-item book-bookmark-item">
              <div data-goto="${bm.page}"><strong>Page ${bm.page}</strong>${bm.note ? `<div class="meta" style="margin-top:2px;">${escapeHtml(bm.note)}</div>` : ''}</div>
              <button class="btn small danger" data-edit-bm="${bm.page}">Edit</button>
            </div>`).join('')}
        </div>
        <div class="book-page-area">
          <div class="book-controls">
            <button class="btn small" id="bv-prev">← Prev</button>
            <span class="mono" style="font-size:12px;">Page <input id="bv-pagenum" type="number" min="1" max="${pages.length}" value="${pageNum}"> of ${pages.length}</span>
            <button class="btn small" id="bv-next">Next →</button>
            <button class="btn small" id="bv-bookmark">${isBookmarked ? '★ Bookmarked' : '☆ Bookmark this page'}</button>
            <span style="flex:1;"></span>
            <button class="btn small" id="bv-zoom-out">−</button>
            <span class="meta mono" style="min-width:42px;text-align:center;">${Math.round(zoom*100)}%</span>
            <button class="btn small" id="bv-zoom-in">+</button>
            <button class="btn small" id="bv-zoom-reset">Reset</button>
          </div>
          <div class="book-page-wrap">
            <img src="${pages[pageNum-1].dataUrl}" style="transform:scale(${zoom});" alt="Page ${pageNum}">
          </div>
        </div>
      </div>`;
    body.querySelector('#bv-prev').onclick = ()=> go(pageNum - 1);
    body.querySelector('#bv-next').onclick = ()=> go(pageNum + 1);
    body.querySelector('#bv-pagenum').onchange = (e)=> go(+e.target.value || 1);
    body.querySelector('#bv-bookmark').onclick = ()=> openBookmarkEditor(pageNum);
    body.querySelector('#bv-zoom-out').onclick = ()=> setZoom(zoom - 0.25);
    body.querySelector('#bv-zoom-in').onclick = ()=> setZoom(zoom + 0.25);
    body.querySelector('#bv-zoom-reset').onclick = ()=> setZoom(1);
    body.querySelectorAll('[data-goto]').forEach(el=> el.onclick = ()=> go(+el.dataset.goto));
    body.querySelectorAll('[data-edit-bm]').forEach(el=> el.onclick = ()=> openBookmarkEditor(+el.dataset.editBm));
  }

  renderBody();
}

/* --------------------------- 6. HELPERS --------------------------- */
function initials(str){ return (str||'').split(' ').filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase(); }
function escapeHtml(str){ const div = document.createElement('div'); div.textContent = str ?? ''; return div.innerHTML; }
function tsVal(ts){ return ts && ts.toMillis ? ts.toMillis() : (ts || 0); }
function timeAgo(ts){
  if(!ts) return 'just now';
  const mins = Math.floor((Date.now()-ts)/60000);
  if(mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`;
  const hrs = Math.floor(mins/60);
  if(hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs/24)}d ago`;
}

/* --------------------------- 7. EVENT WIRING --------------------------- */
document.querySelectorAll('.nav-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{ currentView = btn.dataset.view; render(); });
});
document.getElementById('btn-leave-class').addEventListener('click', ()=>{
  if(!confirm('Leave this class on this device? You can rejoin any time with the class code.')) return;
  localStorage.removeItem(LS_CLASS_ID);
  localStorage.removeItem(LS_STUDENT_NAME);
  location.reload();
});

/* --------------------------- 8. INIT --------------------------- */
initGate();