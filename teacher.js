/* =========================================================================
   TEACHER APP
   Sections: 1. Gate (create/resume class)  2. State  3. Renderers
   4. Actions  5. Modals  6. Helpers  7. Event wiring  8. Init
   ========================================================================= */

/* --------------------------- 1. GATE --------------------------- */
const LS_CLASS_ID = 'classroom-hub-teacher-class-id';

function makeClassCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for(let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
  return code;
}

async function hashPasscode(str){
  const enc = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest)).map(b=> b.toString(16).padStart(2,'0')).join('');
}

async function initGate(){
  const savedId = localStorage.getItem(LS_CLASS_ID);
  if(savedId){
    const doc = await db.collection('classes').doc(savedId).get();
    if(doc.exists){ startApp(savedId, doc.data()); return; }
    localStorage.removeItem(LS_CLASS_ID);
  }
  showCreateGate();
}

function showCreateGate(){
  document.getElementById('gate').innerHTML = `
    <div class="gate-card">
      <div class="mark">CH</div>
      <h2>Set up your class</h2>
      <p>This creates a join code your students will use to see assignments and announcements in real time. The password lets you manage this class from other devices later.</p>
      <div class="field"><label>Class name</label><input id="g-class" placeholder="Period 3 — Biology"></div>
      <div class="field"><label>Your name</label><input id="g-teacher" placeholder="Ms. Alvarez"></div>
      <div class="field"><label>Set a teacher password</label><input id="g-password" type="password" placeholder="Something only you know"></div>
      <button class="btn primary" id="g-submit" style="width:100%;">Create class</button>
      <div class="gate-error" id="g-error"></div>
      <p class="meta" style="text-align:center;margin-top:16px;">Already have a class? <a href="#" id="g-switch-resume">Log in on this device</a></p>
    </div>`;
  document.getElementById('g-submit').onclick = async ()=>{
    const className = document.getElementById('g-class').value.trim();
    const teacherName = document.getElementById('g-teacher').value.trim();
    const password = document.getElementById('g-password').value;
    const err = document.getElementById('g-error');
    if(!className || !teacherName || !password){ err.textContent = 'Fill in all fields to continue.'; return; }
    if(password.length < 4){ err.textContent = 'Password should be at least 4 characters.'; return; }
    err.textContent = 'Creating class…';
    try{
      const code = makeClassCode();
      const passcodeHash = await hashPasscode(password);
      const ref = await db.collection('classes').add({
        className, teacherName, code, passcodeHash, createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      localStorage.setItem(LS_CLASS_ID, ref.id);
      const doc = await ref.get();
      startApp(ref.id, doc.data());
    }catch(e){
      err.textContent = 'Could not reach the database. Check firebase-config.js is filled in correctly.';
    }
  };
  document.getElementById('g-switch-resume').onclick = (e)=>{ e.preventDefault(); showResumeGate(); };
}

function showResumeGate(){
  document.getElementById('gate').innerHTML = `
    <div class="gate-card">
      <div class="mark">CH</div>
      <h2>Log in to your class</h2>
      <p>Enter your class join code and the teacher password you set when you created it.</p>
      <div class="field"><label>Class code</label><input id="r-code" class="mono" placeholder="e.g. K7P2QX" style="text-transform:uppercase;letter-spacing:.08em;"></div>
      <div class="field"><label>Teacher password</label><input id="r-password" type="password" placeholder="Your password"></div>
      <button class="btn primary" id="r-submit" style="width:100%;">Log in</button>
      <div class="gate-error" id="r-error"></div>
      <p class="meta" style="text-align:center;margin-top:16px;">New here? <a href="#" id="r-switch-create">Create a class instead</a></p>
    </div>`;
  document.getElementById('r-submit').onclick = async ()=>{
    const code = document.getElementById('r-code').value.trim().toUpperCase();
    const password = document.getElementById('r-password').value;
    const err = document.getElementById('r-error');
    if(!code || !password){ err.textContent = 'Fill in both fields to continue.'; return; }
    err.textContent = 'Checking…';
    try{
      const snap = await db.collection('classes').where('code','==',code).limit(1).get();
      if(snap.empty){ err.textContent = 'No class found with that code.'; return; }
      const doc = snap.docs[0];
      const info = doc.data();
      if(!info.passcodeHash){ err.textContent = 'This class has no password set — it was created before this feature existed.'; return; }
      const hash = await hashPasscode(password);
      if(hash !== info.passcodeHash){ err.textContent = 'Incorrect password.'; return; }
      localStorage.setItem(LS_CLASS_ID, doc.id);
      startApp(doc.id, info);
    }catch(e){
      err.textContent = 'Could not reach the database. Check firebase-config.js is filled in correctly.';
    }
  };
  document.getElementById('r-switch-create').onclick = (e)=>{ e.preventDefault(); showCreateGate(); };
}

/* --------------------------- 2. STATE --------------------------- */
let classId = null;
let classInfo = null;
let currentView = 'dashboard';
let unsubAssignments = null;
let unsubAnnouncements = null;
let unsubQuizzes = null;
let assignments = [];
let announcements = [];
let quizzes = [];

function startApp(id, info){
  classId = id;
  classInfo = info;
  document.getElementById('gate').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('class-code-display').textContent = info.code;
  document.getElementById('who-name').textContent = info.teacherName;
  document.getElementById('who-avatar').textContent = initials(info.teacherName);

  unsubAssignments = db.collection('classes').doc(classId).collection('assignments')
    .onSnapshot(async (snap)=>{
      assignments = [];
      for(const d of snap.docs){
        const a = { id: d.id, ...d.data() };
        const subsSnap = await db.collection('classes').doc(classId).collection('assignments').doc(d.id).collection('submissions').get();
        a.submissionCount = subsSnap.size;
        assignments.push(a);
      }
      render();
      markSynced(true);
    }, ()=> markSynced(false));

  unsubAnnouncements = db.collection('classes').doc(classId).collection('announcements')
    .onSnapshot((snap)=>{
      announcements = snap.docs.map(d=>({ id:d.id, ...d.data() }));
      render();
      markSynced(true);
    }, ()=> markSynced(false));

  unsubQuizzes = db.collection('classes').doc(classId).collection('quizzes')
    .onSnapshot(async (snap)=>{
      quizzes = [];
      for(const d of snap.docs){
        const q = { id: d.id, ...d.data() };
        const respSnap = await db.collection('classes').doc(classId).collection('quizzes').doc(d.id).collection('responses').get();
        q.responseCount = respSnap.size;
        quizzes.push(q);
      }
      render();
      markSynced(true);
    }, ()=> markSynced(false));
}

function markSynced(ok){
  const dot = document.getElementById('sync-dot');
  const label = document.getElementById('sync-label');
  if(ok){ dot.classList.remove('offline'); label.textContent = 'Live-synced with students'; }
  else{ dot.classList.add('offline'); label.textContent = 'Connection issue — check network'; }
}

/* --------------------------- 3. RENDERERS --------------------------- */
const viewRoot = document.getElementById('view-root');

function render(){
  document.querySelectorAll('.nav-btn').forEach(b=> b.classList.toggle('active', b.dataset.view === currentView));
  const renderers = { dashboard: renderDashboard, assignments: renderAssignments, announcements: renderAnnouncements, quizzes: renderQuizzes };
  (renderers[currentView] || renderDashboard)();
}

function setHeader(title, subtitle){
  document.getElementById('view-title').textContent = title;
  document.getElementById('view-subtitle').textContent = subtitle;
}

function renderDashboard(){
  setHeader('Dashboard', `Overview of ${classInfo.className}.`);
  const upcoming = [...assignments].sort((a,b)=> (a.dueDate||'').localeCompare(b.dueDate||'')).slice(0,3);
  const recentAnnouncement = [...announcements].sort((a,b)=> tsVal(b.postedAt)-tsVal(a.postedAt))[0];

  let html = `<div class="grid-2">`;
  html += `<div class="card"><h3>Upcoming assignments</h3>`;
  if(upcoming.length === 0){ html += `<p class="meta">Nothing assigned yet.</p>`; }
  else{
    upcoming.forEach(a=>{
      const status = statusFor(a);
      html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:0.5px solid var(--line);">
        <div><div style="font-weight:600;font-size:13px;">${escapeHtml(a.title)}</div><div class="meta">Due ${a.dueDate} · ${a.submissionCount} submitted</div></div>
        <span class="stamp ${status.cls}">${status.label}</span>
      </div>`;
    });
  }
  html += `</div>`;

  html += `<div class="card"><h3>Latest announcement</h3>`;
  if(!recentAnnouncement){ html += `<p class="meta">No announcements yet.</p>`; }
  else{
    html += `<div style="font-weight:600;font-size:13px;">${escapeHtml(recentAnnouncement.title)}</div>
      <p class="body-text">${escapeHtml(recentAnnouncement.body)}</p>
      <div class="meta">${timeAgo(tsVal(recentAnnouncement.postedAt))}</div>`;
  }
  html += `</div></div>`;

  html += `<div class="card"><h3>Share with your class</h3>
    <p class="meta">Students join at the student page and enter this code:</p>
    <div class="mono" style="font-size:20px;font-weight:700;color:var(--amber-dark);letter-spacing:.1em;margin-top:6px;">${classInfo.code}</div>
  </div>`;

  viewRoot.innerHTML = html;
}

function renderAssignments(){
  setHeader('Assignments', 'Create and track assignments for your class.');
  let html = `<div class="section-head"><div></div><button class="btn primary small" id="btn-new-assignment">New assignment</button></div>`;

  if(assignments.length === 0){
    html += `<div class="empty"><h3>No assignments yet</h3><p>Create your first assignment to get the class started.</p></div>`;
    viewRoot.innerHTML = html;
    document.getElementById('btn-new-assignment').onclick = openAssignmentModal;
    return;
  }

  [...assignments].sort((a,b)=> (a.dueDate||'').localeCompare(b.dueDate||'')).forEach(a=>{
    const status = statusFor(a);
    html += `<div class="card">
      <div class="card-row">
        <div>
          <h3>${escapeHtml(a.title)}</h3>
          <div class="meta">Due ${a.dueDate} · ${a.submissionCount} submitted</div>
          <p class="body-text">${escapeHtml(a.instructions)}</p>
        </div>
        <span class="stamp ${status.cls}">${status.label}</span>
      </div>
      <div class="form-actions">
        <button class="btn small" data-review="${a.id}">View submissions</button>
        <button class="btn small danger" data-delete="${a.id}">Delete</button>
      </div>
    </div>`;
  });

  viewRoot.innerHTML = html;
  document.getElementById('btn-new-assignment').onclick = openAssignmentModal;
  viewRoot.querySelectorAll('[data-review]').forEach(b=> b.onclick = ()=> openReviewModal(b.dataset.review));
  viewRoot.querySelectorAll('[data-delete]').forEach(b=> b.onclick = ()=> deleteAssignment(b.dataset.delete));
}

function renderAnnouncements(){
  setHeader('Announcements', 'Post updates for the whole class to see.');
  let html = `<div class="section-head"><div></div><button class="btn primary small" id="btn-new-announcement">New announcement</button></div>`;

  if(announcements.length === 0){
    html += `<div class="empty"><h3>No announcements yet</h3><p>Post an update to notify the class.</p></div>`;
  }else{
    [...announcements].sort((a,b)=> tsVal(b.postedAt)-tsVal(a.postedAt)).forEach(n=>{
      html += `<div class="card">
        <div class="card-row">
          <div>
            <h3>${escapeHtml(n.title)}</h3>
            <div class="meta">${timeAgo(tsVal(n.postedAt))}</div>
            <p class="body-text">${escapeHtml(n.body)}</p>
          </div>
          <button class="btn small danger" data-delete-ann="${n.id}">Delete</button>
        </div>
      </div>`;
    });
  }
  viewRoot.innerHTML = html;
  document.getElementById('btn-new-announcement').onclick = openAnnouncementModal;
  viewRoot.querySelectorAll('[data-delete-ann]').forEach(b=> b.onclick = ()=> deleteAnnouncement(b.dataset.deleteAnn));
}

function renderQuizzes(){
  setHeader('Quizzes', 'Build quizzes and see how the class did.');
  let html = `<div class="section-head"><div></div><button class="btn primary small" id="btn-new-quiz">New quiz</button></div>`;

  if(quizzes.length === 0){
    html += `<div class="empty"><h3>No quizzes yet</h3><p>Create a quiz with multiple choice or text questions.</p></div>`;
    viewRoot.innerHTML = html;
    document.getElementById('btn-new-quiz').onclick = openQuizModal;
    return;
  }

  quizzes.forEach(q=>{
    html += `<div class="card">
      <div class="card-row">
        <div>
          <h3>${escapeHtml(q.title)}</h3>
          <div class="meta">${q.questions.length} question${q.questions.length===1?'':'s'} · ${q.responseCount} student${q.responseCount===1?'':'s'} responded</div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn small" data-quiz-results="${q.id}">View results</button>
        <button class="btn small danger" data-delete-quiz="${q.id}">Delete</button>
      </div>
    </div>`;
  });

  viewRoot.innerHTML = html;
  document.getElementById('btn-new-quiz').onclick = openQuizModal;
  viewRoot.querySelectorAll('[data-quiz-results]').forEach(b=> b.onclick = ()=> openQuizResultsModal(b.dataset.quizResults));
  viewRoot.querySelectorAll('[data-delete-quiz]').forEach(b=> b.onclick = ()=> deleteQuiz(b.dataset.deleteQuiz));
}

/* --------------------------- 4. ACTIONS --------------------------- */
function statusFor(assignment){
  const overdue = assignment.dueDate && new Date(assignment.dueDate) < new Date(new Date().toDateString());
  if(assignment.submissionCount > 0) return { cls:'submitted', label: overdue ? 'in — was due' : 'submissions in' };
  if(overdue) return { cls:'overdue', label:'overdue' };
  return { cls:'assigned', label:'open' };
}

async function deleteAssignment(id){
  await db.collection('classes').doc(classId).collection('assignments').doc(id).delete();
}
async function deleteAnnouncement(id){
  await db.collection('classes').doc(classId).collection('announcements').doc(id).delete();
}
async function deleteQuiz(id){
  if(!confirm('Delete this quiz? Student responses to it will no longer be visible.')) return;
  await db.collection('classes').doc(classId).collection('quizzes').doc(id).delete();
}

/* --------------------------- 5. MODALS --------------------------- */
function openModal(html){
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  bg.addEventListener('click', (e)=>{ if(e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  return bg;
}

function openAssignmentModal(){
  const modal = openModal(`
    <h3>New assignment</h3>
    <div class="field"><label>Title</label><input id="f-title" placeholder="Cell structure worksheet"></div>
    <div class="field"><label>Instructions</label><textarea id="f-instr" rows="3" placeholder="What should students do?"></textarea></div>
    <div class="field"><label>Due date</label><input id="f-due" type="date" value="${addDays(3)}"></div>
    <div class="form-actions"><button class="btn" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">Post assignment</button></div>
  `);
  modal.querySelector('#f-cancel').onclick = ()=> modal.remove();
  modal.querySelector('#f-save').onclick = async ()=>{
    const title = modal.querySelector('#f-title').value.trim();
    if(!title) return;
    await db.collection('classes').doc(classId).collection('assignments').add({
      title,
      instructions: modal.querySelector('#f-instr').value.trim(),
      dueDate: modal.querySelector('#f-due').value || addDays(3),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    modal.remove();
  };
}

function openAnnouncementModal(){
  const modal = openModal(`
    <h3>New announcement</h3>
    <div class="field"><label>Title</label><input id="f-title" placeholder="Quiz moved to Friday"></div>
    <div class="field"><label>Message</label><textarea id="f-body" rows="3" placeholder="What do you want the class to know?"></textarea></div>
    <div class="form-actions"><button class="btn" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">Post</button></div>
  `);
  modal.querySelector('#f-cancel').onclick = ()=> modal.remove();
  modal.querySelector('#f-save').onclick = async ()=>{
    const title = modal.querySelector('#f-title').value.trim();
    if(!title) return;
    await db.collection('classes').doc(classId).collection('announcements').add({
      title, body: modal.querySelector('#f-body').value.trim(),
      postedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    modal.remove();
  };
}

async function openReviewModal(assignmentId){
  const subsSnap = await db.collection('classes').doc(classId).collection('assignments').doc(assignmentId).collection('submissions').get();
  const rows = subsSnap.docs.map(d=>{
    const s = d.data();
    return `<tr><td style="font-weight:600;">${escapeHtml(s.studentName)}</td><td class="meta">${escapeHtml(s.text || '(no text)')}</td><td class="meta">${timeAgo(tsVal(s.submittedAt))}</td></tr>`;
  }).join('');
  const modal = openModal(`
    <h3>Submissions</h3>
    ${subsSnap.empty ? '<p class="meta">No submissions yet.</p>' : `<div style="max-height:320px;overflow:auto;"><table style="width:100%;font-size:13px;border-collapse:collapse;"><thead><tr><th style="text-align:left;padding:6px;">Student</th><th style="text-align:left;padding:6px;">Response</th><th style="text-align:left;padding:6px;">When</th></tr></thead><tbody>${rows}</tbody></table></div>`}
    <div class="form-actions"><button class="btn" id="f-close">Close</button></div>
  `);
  modal.querySelector('#f-close').onclick = ()=> modal.remove();
}

function newQuestionId(){ return 'q' + Math.random().toString(36).slice(2, 10); }

function blankQuestion(){
  return { id: newQuestionId(), type: 'mc', questionText: '', imageUrl: '', options: ['', '', ''], correctAnswer: '', maxAttempts: 3 };
}

function questionRowHtml(q, index){
  const isMc = q.type === 'mc';
  return `<div class="qbuilder-row" data-qrow="${q.id}">
    <button type="button" class="btn small danger remove-q" data-remove-q="${q.id}">Remove</button>
    <div class="meta" style="margin-bottom:8px;font-weight:700;">Question ${index + 1}</div>
    <div class="field"><label>Question text</label><textarea rows="2" data-q-text="${q.id}" placeholder="What is the powerhouse of the cell?">${escapeHtml(q.questionText)}</textarea></div>
    <div class="field"><label>Image URL (optional)</label><input data-q-image="${q.id}" placeholder="https://example.com/diagram.png" value="${escapeHtml(q.imageUrl)}"></div>
    <div class="field"><label>Answer type</label>
      <select data-q-type="${q.id}">
        <option value="mc" ${isMc ? 'selected' : ''}>Multiple choice</option>
        <option value="text" ${!isMc ? 'selected' : ''}>Text answer</option>
      </select>
    </div>
    <div data-q-options-wrap="${q.id}">${optionsHtml(q)}</div>
    <div class="field"><label>Correct answer${isMc ? ' (must exactly match one option above)' : ' (not case sensitive)'}</label><input data-q-correct="${q.id}" placeholder="${isMc ? 'Copy the correct option exactly' : 'e.g. Mitochondria'}" value="${escapeHtml(q.correctAnswer)}"></div>
    <div class="field"><label>Attempts allowed before the answer is revealed</label><input type="number" min="1" value="${q.maxAttempts || 3}" data-q-attempts="${q.id}" style="width:100px;"></div>
  </div>`;
}

function optionsHtml(q){
  if(q.type !== 'mc') return '';
  const opts = (q.options && q.options.length) ? q.options : ['', '', ''];
  return `<div class="field"><label>Options</label>
    ${opts.map((o, i)=> `<input class="opt-input" data-q-opt="${q.id}" data-opt-index="${i}" value="${escapeHtml(o)}" placeholder="Option ${i + 1}">`).join('')}
    <button type="button" class="btn small" data-add-opt="${q.id}">Add option</button></div>`;
}

function openQuizModal(){
  let builderQuestions = [blankQuestion()];

  const modal = openModal(`
    <h3>New quiz</h3>
    <div class="field"><label>Quiz title</label><input id="qz-title" placeholder="Chapter 4 review"></div>
    <div id="qz-questions"></div>
    <button type="button" class="btn small" id="qz-add-question">Add question</button>
    <div class="form-actions"><button class="btn" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">Create quiz</button></div>
  `);

  function syncFromDom(){
    builderQuestions.forEach(q=>{
      const row = modal.querySelector(`[data-qrow="${q.id}"]`);
      if(!row) return;
      q.questionText = row.querySelector(`[data-q-text="${q.id}"]`).value;
      q.imageUrl = row.querySelector(`[data-q-image="${q.id}"]`).value.trim();
      q.type = row.querySelector(`[data-q-type="${q.id}"]`).value;
      q.correctAnswer = row.querySelector(`[data-q-correct="${q.id}"]`).value.trim();
      q.maxAttempts = parseInt(row.querySelector(`[data-q-attempts="${q.id}"]`).value, 10) || 3;
      if(q.type === 'mc'){
        const optInputs = row.querySelectorAll(`[data-q-opt="${q.id}"]`);
        q.options = Array.from(optInputs).map(i=> i.value.trim());
      }
    });
  }

  function renderBuilder(){
    const wrap = modal.querySelector('#qz-questions');
    wrap.innerHTML = builderQuestions.map((q, i)=> questionRowHtml(q, i)).join('');

    wrap.querySelectorAll('[data-remove-q]').forEach(btn=>{
      btn.onclick = ()=>{
        syncFromDom();
        builderQuestions = builderQuestions.filter(q=> q.id !== btn.dataset.removeQ);
        if(builderQuestions.length === 0) builderQuestions = [blankQuestion()];
        renderBuilder();
      };
    });
    wrap.querySelectorAll('[data-q-type]').forEach(sel=>{
      sel.onchange = ()=>{
        syncFromDom();
        const q = builderQuestions.find(x=> x.id === sel.dataset.qType);
        q.type = sel.value;
        if(q.type === 'mc' && (!q.options || q.options.length === 0)) q.options = ['', '', ''];
        renderBuilder();
      };
    });
    wrap.querySelectorAll('[data-add-opt]').forEach(btn=>{
      btn.onclick = ()=>{
        syncFromDom();
        const q = builderQuestions.find(x=> x.id === btn.dataset.addOpt);
        q.options.push('');
        renderBuilder();
      };
    });
  }

  renderBuilder();

  modal.querySelector('#qz-add-question').onclick = ()=>{
    syncFromDom();
    builderQuestions.push(blankQuestion());
    renderBuilder();
  };
  modal.querySelector('#f-cancel').onclick = ()=> modal.remove();
  modal.querySelector('#f-save').onclick = async ()=>{
    syncFromDom();
    const title = modal.querySelector('#qz-title').value.trim();
    if(!title){ alert('Give the quiz a title.'); return; }
    for(const q of builderQuestions){
      if(!q.questionText.trim()){ alert('Every question needs question text.'); return; }
      if(q.type === 'mc'){
        q.options = q.options.filter(o=> o.trim() !== '');
        if(q.options.length < 2){ alert(`"${q.questionText}" needs at least 2 options.`); return; }
        if(!q.options.includes(q.correctAnswer)){ alert(`The correct answer for "${q.questionText}" must exactly match one of its options.`); return; }
      } else if(!q.correctAnswer.trim()){
        alert(`Add a correct answer for "${q.questionText}".`);
        return;
      }
      if(!q.maxAttempts || q.maxAttempts < 1) q.maxAttempts = 1;
    }
    await db.collection('classes').doc(classId).collection('quizzes').add({
      title,
      questions: builderQuestions,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    modal.remove();
  };
}

async function openQuizResultsModal(quizId){
  const quiz = quizzes.find(q=> q.id === quizId);
  const respSnap = await db.collection('classes').doc(classId).collection('quizzes').doc(quizId).collection('responses').get();

  let body;
  if(respSnap.empty){
    body = '<p class="meta">No responses yet.</p>';
  }else{
    let rows = '';
    respSnap.docs.forEach(d=>{
      const r = d.data();
      rows += `<tr><td style="padding:6px;font-weight:600;">${escapeHtml(r.studentName)}</td>`;
      quiz.questions.forEach(q=>{
        const a = r.answers && r.answers[q.id];
        if(!a || !a.attempts || a.attempts.length === 0){
          rows += `<td style="padding:6px;" class="meta">—</td>`;
          return;
        }
        const used = a.attempts.length;
        let tag;
        if(a.solved) tag = `<span class="feedback correct" style="margin:0;">correct (${used})</span>`;
        else if(used >= q.maxAttempts) tag = `<span class="feedback revealed" style="margin:0;">revealed (${used})</span>`;
        else tag = `<span class="feedback incorrect" style="margin:0;">trying (${used})</span>`;
        rows += `<td style="padding:6px;">${tag}</td>`;
      });
      rows += `</tr>`;
    });
    body = `<div style="max-height:360px;overflow:auto;"><table style="width:100%;font-size:12px;border-collapse:collapse;">
      <thead><tr><th style="text-align:left;padding:6px;">Student</th>${quiz.questions.map((q, i)=> `<th style="text-align:left;padding:6px;">Q${i + 1}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  const modal = openModal(`<h3>Results — ${escapeHtml(quiz.title)}</h3>${body}<div class="form-actions"><button class="btn" id="f-close">Close</button></div>`);
  modal.querySelector('#f-close').onclick = ()=> modal.remove();
}

/* --------------------------- 6. HELPERS --------------------------- */
function addDays(n){ const d = new Date(); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
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
  if(!confirm('Stop managing this class on this device? Your data stays saved — you can rejoin by creating a class again is not needed, this only clears local access.')) return;
  localStorage.removeItem(LS_CLASS_ID);
  location.reload();
});

/* --------------------------- 8. INIT --------------------------- */
initGate();