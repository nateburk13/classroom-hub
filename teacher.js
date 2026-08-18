/* =========================================================================
   TEACHER APP
   Sections: 1. Gate (create/resume class)  2. State  3. Renderers
   4. Actions  5. Modals  6. Helpers  7. Event wiring  8. Init
   ========================================================================= */

/* --------------------------- 1. GATE --------------------------- */
// Multi-class storage: LS_CLASSES holds every class this teacher manages on
// this device ([{id, className}]); LS_ACTIVE_CLASS remembers which one was
// open last. A join "code" is still generated and stored per-class for
// backward compatibility, but the UI never shows it — teachers and students
// both identify a class by its (unique) name instead.
const LS_CLASSES = 'classroom-hub-teacher-classes';
const LS_ACTIVE_CLASS = 'classroom-hub-teacher-active-class';

function getStoredClasses(){
  try{ return JSON.parse(localStorage.getItem(LS_CLASSES) || '[]'); }catch(e){ return []; }
}
function saveStoredClasses(list){ localStorage.setItem(LS_CLASSES, JSON.stringify(list)); }
function upsertStoredClass(id, className){
  const list = getStoredClasses();
  const i = list.findIndex(c=> c.id === id);
  if(i >= 0) list[i].className = className; else list.push({ id, className });
  saveStoredClasses(list);
}
function removeStoredClass(id){ saveStoredClasses(getStoredClasses().filter(c=> c.id !== id)); }
function setActiveClass(id){ localStorage.setItem(LS_ACTIVE_CLASS, id); }
function getActiveClass(){ return localStorage.getItem(LS_ACTIVE_CLASS); }

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
  const list = getStoredClasses();
  const tryId = getActiveClass() || (list[0] && list[0].id);
  if(tryId){
    const doc = await db.collection('classes').doc(tryId).get();
    if(doc.exists){ startApp(tryId, doc.data()); return; }
    removeStoredClass(tryId);
    return initGate();
  }
  showCreateGate();
}

function showCreateGate(fromSwitcher){
  document.getElementById('gate').innerHTML = `
    <div class="gate-card">
      <div class="mark">CH</div>
      <h2>Set up your class</h2>
      <p>Choose a unique class name — students pick it from a list, no join code to share. The password lets you manage this class from other devices later.</p>
      <div class="field"><label>Class name</label><input id="g-class" placeholder="Period 3 — Biology"></div>
      <div class="field"><label>Your name</label><input id="g-teacher" placeholder="Ms. Alvarez"></div>
      <div class="field">
        <label>Set a teacher password</label>
        <input id="g-password" type="password" placeholder="Something only you know" autocomplete="new-password" aria-describedby="g-password-hint">
        <div class="meta" id="g-password-hint" style="margin-top:4px;">At least 4 characters.</div>
      </div>
      <div class="field"><label>Security question (for password recovery)</label><input id="g-secq" placeholder="e.g. What street did you grow up on?"></div>
      <div class="field"><label>Answer</label><input id="g-seca" placeholder="Your answer"></div>
      <button class="btn primary" id="g-submit" style="width:100%;">Create class</button>
      <div class="gate-error" id="g-error" role="alert"></div>
      <p class="meta" style="text-align:center;margin-top:16px;">
        ${fromSwitcher ? '<a href="#" id="g-back">‹ Back to my class</a> · ' : ''}<a href="#" id="g-switch-resume">Log in to a class from another device</a>
      </p>
    </div>`;
  if(fromSwitcher){
    document.getElementById('g-back').onclick = (e)=>{ e.preventDefault(); document.getElementById('gate').classList.add('hidden'); document.getElementById('app').classList.remove('hidden'); };
  }
  const pwField = document.getElementById('g-password');
  const pwHint = document.getElementById('g-password-hint');
  pwField.addEventListener('input', ()=>{
    if(pwField.value.length === 0){ pwHint.textContent = 'At least 4 characters.'; pwHint.style.color = 'var(--slate)'; }
    else if(pwField.value.length < 4){ pwHint.textContent = `${4 - pwField.value.length} more character${4 - pwField.value.length === 1 ? '' : 's'} needed.`; pwHint.style.color = 'var(--coral)'; }
    else{ pwHint.textContent = 'Looks good.'; pwHint.style.color = 'var(--green-ok)'; }
  });
  document.getElementById('g-submit').onclick = async ()=>{
    const className = document.getElementById('g-class').value.trim();
    const teacherName = document.getElementById('g-teacher').value.trim();
    const password = document.getElementById('g-password').value;
    const secQuestion = document.getElementById('g-secq').value.trim();
    const secAnswer = document.getElementById('g-seca').value.trim();
    const err = document.getElementById('g-error');
    if(!className || !teacherName || !password || !secQuestion || !secAnswer){ err.textContent = 'Fill in all fields to continue — the security question lets you recover your password later.'; return; }
    if(password.length < 4){ err.textContent = 'Password should be at least 4 characters.'; return; }
    err.textContent = 'Checking class name…';
    try{
      const dupe = await db.collection('classes').where('className','==',className).limit(1).get();
      if(!dupe.empty){ err.textContent = 'That class name is already taken — please choose another.'; return; }
      err.textContent = 'Creating class…';
      const code = makeClassCode();
      const passcodeHash = await hashPasscode(password);
      const securityAnswerHash = await hashPasscode(secAnswer.toLowerCase());
      const ref = await db.collection('classes').add({
        className, teacherName, code, passcodeHash,
        securityQuestion: secQuestion, securityAnswerHash,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      const doc = await ref.get();
      if(fromSwitcher) teardownListeners();
      upsertStoredClass(ref.id, className);
      setActiveClass(ref.id);
      startApp(ref.id, doc.data());
    }catch(e){
      err.textContent = 'Could not reach the database. Check firebase-config.js is filled in correctly.';
    }
  };
  document.getElementById('g-switch-resume').onclick = (e)=>{ e.preventDefault(); showResumeGate(fromSwitcher); };
}

function showResumeGate(fromSwitcher){
  document.getElementById('gate').innerHTML = `
    <div class="gate-card">
      <div class="mark">CH</div>
      <h2>Log in to your class</h2>
      <p>Enter the class name and the teacher password you set when you created it.</p>
      <div class="field"><label>Class name</label><input id="r-class" placeholder="Period 3 — Biology"></div>
      <div class="field"><label>Teacher password</label><input id="r-password" type="password" placeholder="Your password"></div>
      <button class="btn primary" id="r-submit" style="width:100%;">Log in</button>
      <div class="gate-error" id="r-error" role="alert"></div>
      <p class="meta" style="text-align:center;margin-top:16px;">
        <a href="#" id="r-forgot">Forgot your password?</a><br>
        New here? <a href="#" id="r-switch-create">Create a class instead</a>
      </p>
    </div>`;
  document.getElementById('r-forgot').onclick = (e)=>{ e.preventDefault(); showForgotPasswordGate(fromSwitcher); };
  document.getElementById('r-submit').onclick = async ()=>{
    const className = document.getElementById('r-class').value.trim();
    const password = document.getElementById('r-password').value;
    const err = document.getElementById('r-error');
    if(!className || !password){ err.textContent = 'Fill in both fields to continue.'; return; }
    err.textContent = 'Checking…';
    try{
      const snap = await db.collection('classes').where('className','==',className).limit(1).get();
      if(snap.empty){ err.textContent = 'No class found with that name.'; return; }
      const doc = snap.docs[0];
      const info = doc.data();
      if(!info.passcodeHash){ err.textContent = 'This class has no password set — it was created before this feature existed.'; return; }
      const hash = await hashPasscode(password);
      if(hash !== info.passcodeHash){ err.textContent = 'Incorrect password.'; return; }
      if(fromSwitcher) teardownListeners();
      upsertStoredClass(doc.id, info.className);
      setActiveClass(doc.id);
      startApp(doc.id, info);
    }catch(e){
      err.textContent = 'Could not reach the database. Check firebase-config.js is filled in correctly.';
    }
  };
  document.getElementById('r-switch-create').onclick = (e)=>{ e.preventDefault(); showCreateGate(fromSwitcher); };
}

function showForgotPasswordGate(fromSwitcher){
  document.getElementById('gate').innerHTML = `
    <div class="gate-card">
      <div class="mark">CH</div>
      <h2>Reset your password</h2>
      <p>Enter your class name — if it has a security question set up, you'll be able to answer it and choose a new password.</p>
      <div class="field"><label>Class name</label><input id="f-class" placeholder="Period 3 — Biology"></div>
      <button class="btn primary" id="f-lookup" style="width:100%;">Continue</button>
      <div class="gate-error" id="f-error" role="alert"></div>
      <p class="meta" style="text-align:center;margin-top:16px;"><a href="#" id="f-back">‹ Back to log in</a></p>
    </div>`;
  document.getElementById('f-back').onclick = (e)=>{ e.preventDefault(); showResumeGate(fromSwitcher); };
  document.getElementById('f-lookup').onclick = async ()=>{
    const className = document.getElementById('f-class').value.trim();
    const err = document.getElementById('f-error');
    if(!className){ err.textContent = 'Enter your class name to continue.'; return; }
    err.textContent = 'Looking up class…';
    try{
      const snap = await db.collection('classes').where('className','==',className).limit(1).get();
      if(snap.empty){ err.textContent = 'No class found with that name.'; return; }
      const doc = snap.docs[0];
      const info = doc.data();
      if(!info.securityQuestion || !info.securityAnswerHash){
        err.textContent = 'This class has no security question set up, so it can\u2019t be recovered this way. Contact your school\u2019s tech support, or ask a colleague with Firebase Console access to reset it manually.';
        return;
      }
      showAnswerSecurityQuestion(doc.id, info, fromSwitcher);
    }catch(e){
      err.textContent = 'Could not reach the database. Check firebase-config.js is filled in correctly.';
    }
  };
}

function showAnswerSecurityQuestion(classDocId, info, fromSwitcher){
  document.getElementById('gate').innerHTML = `
    <div class="gate-card">
      <div class="mark">CH</div>
      <h2>Answer your security question</h2>
      <p>${escapeHtml(info.securityQuestion)}</p>
      <div class="field"><label>Answer</label><input id="a-answer" placeholder="Your answer"></div>
      <div class="field"><label>New password</label><input id="a-password" type="password" placeholder="At least 4 characters" autocomplete="new-password"></div>
      <button class="btn primary" id="a-submit" style="width:100%;">Reset password</button>
      <div class="gate-error" id="a-error" role="alert"></div>
      <p class="meta" style="text-align:center;margin-top:16px;"><a href="#" id="a-back">‹ Back to log in</a></p>
    </div>`;
  document.getElementById('a-back').onclick = (e)=>{ e.preventDefault(); showResumeGate(fromSwitcher); };
  document.getElementById('a-submit').onclick = async ()=>{
    const answer = document.getElementById('a-answer').value.trim();
    const newPassword = document.getElementById('a-password').value;
    const err = document.getElementById('a-error');
    if(!answer || !newPassword){ err.textContent = 'Fill in both fields to continue.'; return; }
    if(newPassword.length < 4){ err.textContent = 'Password should be at least 4 characters.'; return; }
    err.textContent = 'Checking…';
    try{
      const answerHash = await hashPasscode(answer.toLowerCase());
      if(answerHash !== info.securityAnswerHash){ err.textContent = 'That answer doesn\u2019t match — try again.'; return; }
      const newHash = await hashPasscode(newPassword);
      await db.collection('classes').doc(classDocId).update({ passcodeHash: newHash });
      const freshInfo = { ...info, passcodeHash: newHash };
      if(fromSwitcher) teardownListeners();
      upsertStoredClass(classDocId, freshInfo.className);
      setActiveClass(classDocId);
      startApp(classDocId, freshInfo);
    }catch(e){
      err.textContent = 'Could not reach the database. Check firebase-config.js is filled in correctly.';
    }
  };
}

/* Switch between classes already stored on this device, or load one fresh
   (e.g. right after creating/logging into it). */
async function switchToClass(id){
  if(id === classId) return;
  teardownListeners();
  setActiveClass(id);
  const doc = await db.collection('classes').doc(id).get();
  if(!doc.exists){
    removeStoredClass(id);
    const remaining = getStoredClasses();
    if(remaining.length) return switchToClass(remaining[0].id);
    classId = null; classInfo = null;
    document.getElementById('app').classList.add('hidden');
    document.getElementById('gate').classList.remove('hidden');
    showCreateGate();
    return;
  }
  startApp(id, doc.data());
}

function teardownListeners(){
  if(unsubAssignments) unsubAssignments();
  if(unsubAnnouncements) unsubAnnouncements();
  if(unsubQuizzes) unsubQuizzes();
  if(unsubBooks) unsubBooks();
  if(unsubHomework) unsubHomework();
  if(unsubPresence) unsubPresence();
  unsubAssignments = unsubAnnouncements = unsubQuizzes = unsubBooks = unsubHomework = unsubPresence = null;
  stopTeacherPresence();
  ClassroomCall.teardown();
  Whiteboard.teardown();
  assignments = []; announcements = []; quizzes = []; books = []; homework = []; presence = [];
  loaded = { assignments: false, announcements: false, quizzes: false, books: false, homework: false, students: false };
  showNewHwForm = false; hwResponsesExpanded = {};
  showNewGrammarForm = false;
}

/* --------------------------- 2. STATE --------------------------- */
let classId = null;
let classInfo = null;
let currentView = 'dashboard';
let unsubAssignments = null;
let unsubAnnouncements = null;
let unsubQuizzes = null;
let unsubBooks = null;
let unsubHomework = null;
let assignments = [];
let announcements = [];
let quizzes = [];
let books = [];
let homework = [];
let presence = [];
let unsubPresence = null;
let loaded = { assignments: false, announcements: false, quizzes: false, books: false, homework: false, students: false };
// Homework tab: categories are a fixed field on each doc (not separate
// collections) so the UI can filter client-side and adding a category later
// is a one-line change. `style` controls which renderer/wiring a category
// uses — add a category by giving it an id/label and reusing one of the
// three existing styles (or add a new style + its renderer if you need a
// genuinely different layout).
//   'builder' -> renderGrammarTeacherView / wireGrammarTeacherView (prompt / questions / worksheet-import)
//   'writing' -> renderWritingTeacherView / wireWritingTeacherView (inline free response)
//   'generic' -> the plain popup-modal flow (openHomeworkModal)
const HOMEWORK_CATEGORIES = [
  { id:'grammar', label:'Grammar', style:'builder' },
  { id:'writing', label:'Writing', style:'writing' },
  { id:'vocab', label:'Vocab', style:'builder' },
  { id:'spelling', label:'Spelling', style:'generic' },
  { id:'speech', label:'Speech', style:'generic' }
];
let currentHwCategory = 'grammar';
// Inline "Writing" tab state (see renderWritingTeacherView): whether the new-
// prompt form is open, and which prompts have their responses expanded.
let showNewHwForm = false;
let hwResponsesExpanded = {};
// Inline "Grammar"/"Vocab" ('builder' style) state (see renderGrammarTeacherView):
// whether the new-homework form is open. Responses reuse hwResponsesExpanded above.
let showNewGrammarForm = false;
const PRESENCE_ONLINE_MS = 60000; // no heartbeat within this window = shown offline
const TEACHER_PRESENCE_ID = '__teacher__';
let teacherPresenceInterval = null;
const PRESENCE_HEARTBEAT_MS = 25000;
/* Live video/audio calls are handled entirely by the shared call.js module
   (window.ClassroomCall) — see ClassroomCall.init() below and callPerson()
   usage in renderStudents(). No teacher-specific call state lives here. */

function startApp(id, info){
  classId = id;
  classInfo = info;
  upsertStoredClass(id, info.className);
  setActiveClass(id);
  document.getElementById('gate').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('who-name').textContent = info.teacherName;
  document.getElementById('who-avatar').textContent = initials(info.teacherName);
  renderClassSwitcher();
  startTeacherPresence();
  ClassroomCall.init({ classId, myId: TEACHER_PRESENCE_ID, myName: info.teacherName, myRole: 'teacher' });
  Whiteboard.init({ classId, myId: TEACHER_PRESENCE_ID, myName: info.teacherName, myRole: 'teacher' });

  unsubAssignments = db.collection('classes').doc(classId).collection('assignments')
    .onSnapshot(async (snap)=>{
      assignments = [];
      for(const d of snap.docs){
        const a = { id: d.id, ...d.data() };
        const subsSnap = await db.collection('classes').doc(classId).collection('assignments').doc(d.id).collection('submissions').get();
        a.submissionCount = subsSnap.size;
        assignments.push(a);
      }
      loaded.assignments = true;
      render();
      markSynced(true);
    }, ()=> markSynced(false));

  unsubAnnouncements = db.collection('classes').doc(classId).collection('announcements')
    .onSnapshot((snap)=>{
      announcements = snap.docs.map(d=>({ id:d.id, ...d.data() }));
      loaded.announcements = true;
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
      loaded.quizzes = true;
      render();
      markSynced(true);
    }, ()=> markSynced(false));

  unsubHomework = db.collection('classes').doc(classId).collection('homework')
    .onSnapshot(async (snap)=>{
      homework = [];
      for(const d of snap.docs){
        const h = { id: d.id, ...d.data() };
        const subsSnap = await db.collection('classes').doc(classId).collection('homework').doc(d.id).collection('submissions').get();
        h.submissionCount = subsSnap.size;
        homework.push(h);
      }
      loaded.homework = true;
      render();
      markSynced(true);
    }, ()=> markSynced(false));

  unsubBooks = db.collection('classes').doc(classId).collection('books')
    .onSnapshot((snap)=>{
      books = snap.docs.map(d=>({ id:d.id, ...d.data() }))
        .sort((a,b)=> tsVal(b.createdAt)-tsVal(a.createdAt));
      loaded.books = true;
      render();
      markSynced(true);
    }, ()=> markSynced(false));

  unsubPresence = db.collection('classes').doc(classId).collection('presence')
    .onSnapshot((snap)=>{
      presence = snap.docs.map(d=>({ id:d.id, ...d.data() })).filter(p=> p.role !== 'teacher');
      loaded.students = true;
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

/* Teacher's own heartbeat, written to the same `presence` collection students
   use, so students can see the teacher is online and call them. Tagged with
   role:'teacher' so the Students tab (and call.js) can tell them apart. */
function touchTeacherPresence(){
  if(!classId) return;
  db.collection('classes').doc(classId).collection('presence').doc(TEACHER_PRESENCE_ID)
    .set({ name: classInfo.teacherName, role: 'teacher', lastSeen: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true })
    .catch((e)=>{
      const label = document.getElementById('sync-label');
      if(label) label.textContent = `Presence blocked (${(e && e.code) ? e.code : 'unknown error'})`;
    });
}
function startTeacherPresence(){
  stopTeacherPresence();
  touchTeacherPresence();
  teacherPresenceInterval = setInterval(touchTeacherPresence, PRESENCE_HEARTBEAT_MS);
}
function stopTeacherPresence(){
  if(teacherPresenceInterval){ clearInterval(teacherPresenceInterval); teacherPresenceInterval = null; }
}

/* Sidebar class switcher: dropdown of every class this teacher manages on
   this device, plus quick actions to add another or remove the current one. */
function renderClassSwitcher(){
  const list = getStoredClasses();
  const box = document.querySelector('.class-code-box');
  box.innerHTML = `
    <label>Class</label>
    <select id="class-switcher" style="margin-bottom:8px;">
      ${list.map(c=> `<option value="${c.id}" ${c.id===classId?'selected':''}>${escapeHtml(c.className)}</option>`).join('')}
      <option value="__add__">+ Add another class</option>
    </select>
    <div class="sync-dot"><span class="dot" id="sync-dot" aria-hidden="true"></span><span id="sync-label" aria-live="polite">Connecting…</span></div>
    <button class="btn small" id="btn-leave-class" style="width:100%;margin-top:10px;">Remove this class</button>
  `;
  document.getElementById('class-switcher').onchange = (e)=>{
    const v = e.target.value;
    if(v === '__add__'){
      e.target.value = classId;
      document.getElementById('app').classList.add('hidden');
      document.getElementById('gate').classList.remove('hidden');
      showCreateGate(true);
      return;
    }
    switchToClass(v);
  };
  document.getElementById('btn-leave-class').onclick = ()=>{
    if(!confirm(`Remove "${classInfo.className}" from this device? Your class data stays saved — you can log back in any time with the class name and password.`)) return;
    removeStoredClass(classId);
    teardownListeners();
    const remaining = getStoredClasses();
    if(remaining.length){ switchToClass(remaining[0].id); return; }
    classId = null; classInfo = null;
    document.getElementById('app').classList.add('hidden');
    document.getElementById('gate').classList.remove('hidden');
    showCreateGate();
  };
}

/* --------------------------- 3. RENDERERS --------------------------- */
const viewRoot = document.getElementById('view-root');

function render(){
  document.querySelectorAll('.nav-btn').forEach(b=> b.classList.toggle('active', b.dataset.view === currentView));
  const renderers = { dashboard: renderDashboard, assignments: renderAssignments, announcements: renderAnnouncements, homework: renderHomework, quizzes: renderQuizzes, books: renderBooks, students: renderStudents, whiteboard: renderWhiteboard };
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
  if(!loaded.assignments){ html += `<p class="meta">Loading…</p>`; }
  else if(upcoming.length === 0){ html += `<p class="meta">Nothing assigned yet.</p>`; }
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
  if(!loaded.announcements){ html += `<p class="meta">Loading…</p>`; }
  else if(!recentAnnouncement){ html += `<p class="meta">No announcements yet.</p>`; }
  else{
    html += `<div style="font-weight:600;font-size:13px;">${escapeHtml(recentAnnouncement.title)}</div>
      <p class="body-text">${escapeHtml(recentAnnouncement.body)}</p>
      <div class="meta">${timeAgo(tsVal(recentAnnouncement.postedAt))}</div>`;
  }
  html += `</div>`;
  html += `</div>`;

  html += `<div class="card"><h3>Class overview</h3>`;
  if(!loaded.assignments || !loaded.students){ html += `<p class="meta">Loading…</p>`; }
  else if(assignments.length === 0){ html += `<p class="meta">Post an assignment to start tracking submission rates.</p>`; }
  else{
    const totalStudents = presence.length;
    const rated = assignments.filter(a=> totalStudents > 0);
    const avgRate = rated.length
      ? Math.round(rated.reduce((sum,a)=> sum + Math.min(a.submissionCount / totalStudents, 1), 0) / rated.length * 100)
      : 0;
    html += `<p class="meta">Average submission rate across ${assignments.length} assignment${assignments.length===1?'':'s'}${totalStudents ? ` (out of ${totalStudents} joined student${totalStudents===1?'':'s'})` : ''}.</p>
      <div style="display:flex;align-items:center;gap:10px;margin-top:10px;">
        <div style="flex:1;height:8px;background:var(--cream);border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${avgRate}%;background:var(--amber);"></div>
        </div>
        <div style="font-weight:700;font-size:14px;color:var(--forest);min-width:38px;text-align:right;">${totalStudents ? avgRate + '%' : '—'}</div>
      </div>`;
  }
  html += `</div>`;

  html += `<div class="card"><h3>Students</h3>`;
  if(!loaded.students){ html += `<p class="meta">Loading…</p>`; }
  else{
    const onlineCount = presence.filter(isOnline).length;
    html += `<p class="meta">${onlineCount} of ${presence.length} student${presence.length===1?'':'s'} online now.</p>
      <button class="btn small" id="btn-view-students" style="margin-top:8px;">View students</button>`;
  }
  html += `</div>`;

  html += `<div class="card"><h3>Share with your class</h3>
    <p class="meta">Students join at the student page and pick this class from the list by name:</p>
    <div style="font-size:16px;font-weight:700;color:var(--amber-dark);margin-top:6px;">${escapeHtml(classInfo.className)}</div>
  </div>`;

  viewRoot.innerHTML = html;
  const viewStudentsBtn = document.getElementById('btn-view-students');
  if(viewStudentsBtn) viewStudentsBtn.onclick = ()=>{ currentView = 'students'; render(); };
}

function renderAssignments(){
  setHeader('Assignments', 'Create and track assignments for your class.');
  let html = `<div class="section-head"><div></div><button class="btn primary small" id="btn-new-assignment">New assignment</button></div>`;

  if(!loaded.assignments){
    html += `<div class="empty"><h3>Loading assignments…</h3><p>Connecting to your class.</p></div>`;
    viewRoot.innerHTML = html;
    document.getElementById('btn-new-assignment').onclick = openAssignmentModal;
    return;
  }

  if(assignments.length === 0){
    html += `<div class="empty"><h3>No assignments yet</h3><p>Create your first assignment to get the class started.</p></div>`;
    viewRoot.innerHTML = html;
    document.getElementById('btn-new-assignment').onclick = openAssignmentModal;
    return;
  }

  [...assignments].sort((a,b)=> (a.dueDate||'').localeCompare(b.dueDate||'')).forEach(a=>{
    const status = statusFor(a);
    const totalStudents = presence.length;
    const pct = totalStudents ? Math.round(Math.min(a.submissionCount / totalStudents, 1) * 100) : null;
    html += `<div class="card">
      <div class="card-row">
        <div>
          <h3>${escapeHtml(a.title)}</h3>
          <div class="meta">Due ${a.dueDate} · ${a.submissionCount} submitted${pct !== null ? ` (${pct}% of class)` : ''}</div>
          <p class="body-text">${escapeHtml(a.instructions)}</p>
        </div>
        <span class="stamp ${status.cls}">${status.label}</span>
      </div>
      ${pct !== null ? `<div style="height:6px;background:var(--cream);border-radius:3px;overflow:hidden;margin-top:8px;"><div style="height:100%;width:${pct}%;background:var(--amber);"></div></div>` : ''}
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

  if(!loaded.announcements){
    html += `<div class="empty"><h3>Loading announcements…</h3><p>Connecting to your class.</p></div>`;
  }else if(announcements.length === 0){
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

function renderHomework(){
  setHeader('Homework', 'Create homework by category and track submissions.');
  const catMeta = HOMEWORK_CATEGORIES.find(c=> c.id === currentHwCategory);
  const activeLabel = catMeta.label;
  let html = `<div class="pill-tabs">${HOMEWORK_CATEGORIES.map(c=> `<button class="pill-tab ${c.id===currentHwCategory?'active':''}" data-hw-cat="${c.id}">${c.label}</button>`).join('')}</div>`;

  if(!loaded.homework){
    html += `<div class="empty"><h3>Loading homework…</h3><p>Connecting to your class.</p></div>`;
    viewRoot.innerHTML = html;
    wireHomeworkTabs();
    return;
  }

  const items = homework.filter(h=> h.category === currentHwCategory);

  if(catMeta.style === 'writing'){
    html += renderWritingTeacherView(items);
    viewRoot.innerHTML = html;
    wireHomeworkTabs();
    wireWritingTeacherView();
    return;
  }

  if(catMeta.style === 'builder'){
    html += renderGrammarTeacherView(items, currentHwCategory);
    viewRoot.innerHTML = html;
    wireHomeworkTabs();
    wireGrammarTeacherView(currentHwCategory);
    return;
  }

  html += `<div class="section-head"><div></div><button class="btn primary small" id="btn-new-homework">New ${activeLabel.toLowerCase()} homework</button></div>`;
  if(items.length === 0){
    html += `<div class="empty"><h3>No ${activeLabel.toLowerCase()} homework yet</h3><p>Create the first one for this category.</p></div>`;
  }else{
    [...items].sort((a,b)=> (a.dueDate||'').localeCompare(b.dueDate||'')).forEach(h=>{
      const status = statusForHomework(h);
      html += `<div class="card">
        <div class="card-row">
          <div>
            <h3>${escapeHtml(h.title)}</h3>
            <div class="meta">${h.dueDate ? `Due ${h.dueDate} · ` : 'No due date · '}${h.submissionCount} submitted</div>
            <p class="body-text">${escapeHtml(h.instructions)}</p>
            ${h.attachmentUrl ? `<a href="${h.attachmentUrl}" download="${escapeHtml(h.attachmentName || 'attachment')}" class="meta" style="color:var(--forest);text-decoration:underline;">📎 ${escapeHtml(h.attachmentName || 'attachment')}</a>` : ''}
          </div>
          <span class="stamp ${status.cls}">${status.label}</span>
        </div>
        <div class="form-actions">
          <button class="btn small" data-hw-review="${h.id}">View submissions</button>
          <button class="btn small danger" data-hw-delete="${h.id}">Delete</button>
        </div>
      </div>`;
    });
  }
  viewRoot.innerHTML = html;
  wireHomeworkTabs();
  document.getElementById('btn-new-homework').onclick = ()=> openHomeworkModal(currentHwCategory);
  viewRoot.querySelectorAll('[data-hw-review]').forEach(b=> b.onclick = ()=> openHomeworkReviewModal(b.dataset.hwReview));
  viewRoot.querySelectorAll('[data-hw-delete]').forEach(b=> b.onclick = ()=> deleteHomework(b.dataset.hwDelete));
}
function wireHomeworkTabs(){
  viewRoot.querySelectorAll('[data-hw-cat]').forEach(b=> b.onclick = ()=>{ currentHwCategory = b.dataset.hwCat; render(); });
}
function statusForHomework(h){
  const overdue = h.dueDate && new Date(h.dueDate) < new Date(new Date().toDateString());
  if(h.submissionCount > 0) return { cls:'submitted', label: overdue ? 'in — was due' : 'submissions in' };
  if(overdue) return { cls:'overdue', label:'overdue' };
  return { cls:'assigned', label:'open' };
}

// Auto-grades a worksheet submission against each item's optional
// correctAnswer. Case/whitespace-insensitive; mc compares the chosen option
// text directly. Items with no correctAnswer set are left "ungraded" rather
// than counted wrong, since the teacher may not have filled one in.
function normalizeAnswer(v){ return (v || '').toString().trim().toLowerCase().replace(/\s+/g,' '); }
function gradeWorksheetItem(item, given){
  if(!item.correctAnswer) return 'ungraded';
  if(!given) return 'wrong';
  return normalizeAnswer(given) === normalizeAnswer(item.correctAnswer) ? 'correct' : 'wrong';
}
function scoreWorksheetSubmission(h, answers){
  const items = h.items || [];
  let correct = 0, gradable = 0;
  items.forEach(it=>{
    const g = gradeWorksheetItem(it, answers && answers[it.id]);
    if(g !== 'ungraded'){ gradable++; if(g === 'correct') correct++; }
  });
  return { correct, gradable, total: items.length };
}

/* Writing tab: prompts are created inline (no popup) and each prompt's
   responses expand in place underneath it, so the teacher can read full
   student writing without a cramped modal table. */
function renderWritingTeacherView(items){
  let html = `<div class="section-head"><div></div><button class="btn primary small" id="btn-toggle-writing-form">${showNewHwForm ? 'Cancel' : 'New writing prompt'}</button></div>`;

  if(showNewHwForm){
    html += `<div class="card">
      <div class="field"><label>Title</label><input id="wp-title" placeholder="Descriptive paragraph"></div>
      <div class="field"><label>Prompt / instructions</label><textarea id="wp-instr" rows="4" placeholder="Write a paragraph describing your favorite place. Include at least 3 sensory details."></textarea></div>
      <div class="field"><label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="wp-has-due" style="width:auto;" checked> Has a due date</label>
        <input id="wp-due" type="date" value="${addDays(7)}">
      </div>
      <div class="field"><label>Attach a reference file or image (optional)</label><input id="wp-file" type="file" accept="image/*,.pdf,.doc,.docx"></div>
      <div class="form-actions"><button class="btn small" id="wp-cancel">Cancel</button><button class="btn primary small" id="wp-save">Post prompt</button></div>
      <div class="gate-error" id="wp-error"></div>
    </div>`;
  }

  if(items.length === 0){
    html += `<div class="empty"><h3>No writing prompts yet</h3><p>Add a prompt above to get started.</p></div>`;
  }else{
    [...items].sort((a,b)=> (a.dueDate||'').localeCompare(b.dueDate||'')).forEach(h=>{
      const status = statusForHomework(h);
      const expanded = !!hwResponsesExpanded[h.id];
      html += `<div class="card">
        <div class="card-row">
          <div>
            <h3>${escapeHtml(h.title)}</h3>
            <div class="meta">${h.dueDate ? `Due ${h.dueDate} · ` : 'No due date · '}${h.submissionCount} submitted</div>
            <p class="body-text">${escapeHtml(h.instructions)}</p>
            ${h.attachmentUrl ? `<a href="${h.attachmentUrl}" download="${escapeHtml(h.attachmentName || 'attachment')}" class="meta" style="color:var(--forest);text-decoration:underline;">📎 ${escapeHtml(h.attachmentName || 'attachment')}</a>` : ''}
          </div>
          <span class="stamp ${status.cls}">${status.label}</span>
        </div>
        <div class="form-actions">
          <button class="btn small" data-wr-toggle="${h.id}">${expanded ? 'Hide responses' : 'View responses'}</button>
          <button class="btn small danger" data-hw-delete="${h.id}">Delete</button>
        </div>
        <div id="wr-responses-${h.id}">${expanded ? '<p class="meta" style="margin-top:10px;">Loading…</p>' : ''}</div>
      </div>`;
    });
  }
  return html;
}

function wireWritingTeacherView(){
  document.getElementById('btn-toggle-writing-form').onclick = ()=>{ showNewHwForm = !showNewHwForm; render(); };
  if(showNewHwForm){
    document.getElementById('wp-has-due').onchange = (e)=>{ document.getElementById('wp-due').disabled = !e.target.checked; };
    document.getElementById('wp-cancel').onclick = ()=>{ showNewHwForm = false; render(); };
    document.getElementById('wp-save').onclick = async ()=>{
      const title = document.getElementById('wp-title').value.trim();
      const err = document.getElementById('wp-error');
      if(!title){ err.textContent = 'Give the prompt a title.'; return; }
      const saveBtn = document.getElementById('wp-save');
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; err.textContent = '';
      try{
        const file = document.getElementById('wp-file').files[0];
        const attachmentUrl = file ? await fileToAttachment(file) : null;
        const hasDue = document.getElementById('wp-has-due').checked;
        await db.collection('classes').doc(classId).collection('homework').add({
          category: 'writing',
          title,
          instructions: document.getElementById('wp-instr').value.trim(),
          dueDate: hasDue ? (document.getElementById('wp-due').value || addDays(7)) : null,
          attachmentName: file ? file.name : null,
          attachmentUrl,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        showNewHwForm = false;
      }catch(e){
        saveBtn.disabled = false; saveBtn.textContent = 'Post prompt';
        err.textContent = e.message || "Couldn't save — check your connection and try again.";
      }
    };
  }
  viewRoot.querySelectorAll('[data-wr-toggle]').forEach(b=> b.onclick = ()=> toggleWritingResponses(b.dataset.wrToggle));
  viewRoot.querySelectorAll('[data-hw-delete]').forEach(b=> b.onclick = ()=> deleteHomework(b.dataset.hwDelete));
}

async function toggleWritingResponses(hwId){
  const wasExpanded = !!hwResponsesExpanded[hwId];
  hwResponsesExpanded[hwId] = !wasExpanded;
  if(wasExpanded){ render(); return; }
  render(); // shows the "Loading…" placeholder immediately
  const subsSnap = await db.collection('classes').doc(classId).collection('homework').doc(hwId).collection('submissions').get();
  const container = document.getElementById('wr-responses-' + hwId);
  if(!container) return; // user switched tabs before this resolved
  if(subsSnap.empty){ container.innerHTML = '<p class="meta" style="margin-top:10px;">No responses yet.</p>'; return; }
  const docs = [...subsSnap.docs].sort((a,b)=> (a.data().studentName || '').localeCompare(b.data().studentName || ''));
  let html = '<div style="margin-top:10px;display:flex;flex-direction:column;gap:10px;">';
  docs.forEach(d=>{
    const s = d.data();
    html += `<div style="border-top:0.5px solid var(--line);padding-top:10px;">
      <div style="display:flex;justify-content:space-between;gap:10px;"><strong style="font-size:13px;">${escapeHtml(s.studentName)}</strong><span class="meta">attempt ${s.attemptCount || 1} · ${timeAgo(tsVal(s.submittedAt))}</span></div>
      ${s.text ? `<p class="body-text" style="white-space:pre-wrap;margin-top:6px;">${escapeHtml(s.text)}</p>` : '<p class="meta" style="margin-top:6px;">(no typed text)</p>'}
      ${s.attachmentUrl ? `<a href="${s.attachmentUrl}" download="${escapeHtml(s.attachmentName || 'file')}" class="meta">📎 ${escapeHtml(s.attachmentName || 'attached file')}</a>` : ''}
    </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

// ---- Grammar tab: teacher can post either a single free-response prompt
// (like Writing) or a numbered list of short questions students answer
// inline. Both live in the same `homework` doc via the `mode` field. ----
function renderGrammarTeacherView(items, category){
  const catLabel = (HOMEWORK_CATEGORIES.find(c=> c.id === category) || {}).label || 'homework';
  let html = `<div class="section-head"><div></div><button class="btn primary small" id="btn-toggle-grammar-form">${showNewGrammarForm ? 'Cancel' : `New ${catLabel.toLowerCase()} homework`}</button></div>`;

  if(showNewGrammarForm){
    html += `<div class="card">
      <div class="field"><label>Format</label>
        <select id="gr-mode">
          <option value="prompt">Single prompt — student writes a general response</option>
          <option value="questions">List of questions — student answers each one</option>
          <option value="worksheet">Import from PDF — auto-build fill-in-the-blank / multiple choice questions</option>
        </select>
      </div>
      <div class="field"><label>Title</label><input id="gr-title" placeholder="Subject-verb agreement"></div>
      <div class="field" id="gr-instr-wrap"><label>Instructions / prompt</label><textarea id="gr-instr" rows="3" placeholder="What should students do?"></textarea></div>
      <div class="field hidden" id="gr-questions-wrap">
        <label>Questions</label>
        <div id="gr-questions-list"></div>
        <button class="btn small" type="button" id="gr-add-question">+ Add question</button>
      </div>
      <div class="field hidden" id="gr-worksheet-wrap">
        <label>Import a worksheet PDF</label>
        <p class="meta" style="margin:0 0 8px;">Works best on typed PDFs (like a worksheet made in Word/Google Docs). It pulls out numbered items, detects blanks ( ___ ) and multiple-choice options (A/B/C/D), and turns them into editable questions below — nothing posts until you review and save. Scanned or handwritten pages usually won't extract cleanly; you'll still see a page image to work from and can type the questions in by hand.</p>
        <input type="file" id="gr-ws-file" accept="application/pdf">
        <button type="button" class="btn small" id="gr-ws-extract" style="margin-top:8px;">Extract questions</button>
        <p class="meta" id="gr-ws-status" style="margin-top:8px;"></p>
        <div id="gr-ws-page-preview"></div>
        <div id="gr-ws-items" style="margin-top:10px;"></div>
        <button type="button" class="btn small hidden" id="gr-ws-add-item" style="margin-top:6px;">+ Add question manually</button>
      </div>
      <div class="field"><label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="gr-has-due" style="width:auto;" checked> Has a due date</label>
        <input id="gr-due" type="date" value="${addDays(7)}">
      </div>
      <div class="field" id="gr-file-wrap"><label>Attach a file (optional)</label><input id="gr-file" type="file" accept="image/*,.pdf,.doc,.docx"></div>
      <div class="form-actions"><button class="btn small" id="gr-cancel">Cancel</button><button class="btn primary small" id="gr-save">Post homework</button></div>
      <div class="gate-error" id="gr-error"></div>
    </div>`;
  }

  if(items.length === 0){
    html += `<div class="empty"><h3>No ${catLabel.toLowerCase()} homework yet</h3><p>Create the first one for this category.</p></div>`;
  }else{
    [...items].sort((a,b)=> (a.dueDate||'').localeCompare(b.dueDate||'')).forEach(h=>{
      const status = statusForHomework(h);
      const expanded = !!hwResponsesExpanded[h.id];
      const isQ = h.mode === 'questions';
      const isWs = h.mode === 'worksheet';
      const formatLabel = isQ ? `${(h.questions||[]).length} question${(h.questions||[]).length===1?'':'s'}` : isWs ? `${(h.items||[]).length} question${(h.items||[]).length===1?'':'s'} · from PDF` : 'single prompt';
      html += `<div class="card">
        <div class="card-row">
          <div>
            <h3>${escapeHtml(h.title)}</h3>
            <div class="meta">${h.dueDate ? `Due ${h.dueDate} · ` : 'No due date · '}${h.submissionCount} submitted · ${formatLabel}</div>
            ${h.instructions ? `<p class="body-text">${escapeHtml(h.instructions)}</p>` : ''}
            ${isQ ? `<ol style="margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--forest);">${(h.questions||[]).map(q=> `<li>${escapeHtml(q.text)}</li>`).join('')}</ol>` : ''}
            ${isWs ? `<ol style="margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--forest);">${(h.items||[]).map(it=> `<li>${escapeHtml((it.stem||'').replace('{{blank}}','____'))}</li>`).join('')}</ol>` : ''}
            ${isWs && h.attachmentUrl ? `<img src="${h.attachmentUrl}" style="max-width:180px;border-radius:8px;border:0.5px solid var(--line);margin-top:8px;display:block;">` : ''}
            ${!isWs && h.attachmentUrl ? `<a href="${h.attachmentUrl}" download="${escapeHtml(h.attachmentName || 'attachment')}" class="meta" style="color:var(--forest);text-decoration:underline;">📎 ${escapeHtml(h.attachmentName || 'attachment')}</a>` : ''}
          </div>
          <span class="stamp ${status.cls}">${status.label}</span>
        </div>
        <div class="form-actions">
          <button class="btn small" data-gr-toggle="${h.id}">${expanded ? 'Hide responses' : 'View responses'}</button>
          <button class="btn small danger" data-hw-delete="${h.id}">Delete</button>
        </div>
        <div id="gr-responses-${h.id}">${expanded ? '<p class="meta" style="margin-top:10px;">Loading…</p>' : ''}</div>
      </div>`;
    });
  }
  return html;
}

function wireGrammarTeacherView(category){
  document.getElementById('btn-toggle-grammar-form').onclick = ()=>{ showNewGrammarForm = !showNewGrammarForm; render(); };

  if(showNewGrammarForm){
    const modeSel = document.getElementById('gr-mode');
    const instrLabel = document.querySelector('#gr-instr-wrap label');
    const qWrap = document.getElementById('gr-questions-wrap');
    const qList = document.getElementById('gr-questions-list');
    const wsWrap = document.getElementById('gr-worksheet-wrap');
    const fileWrap = document.getElementById('gr-file-wrap');

    // Worksheet-mode builder state. Lives in this closure (like the quiz
    // builder modal) rather than module state, since the form is rebuilt
    // fresh every time it's opened.
    let wsItems = [];
    let wsPageImage = null;

    function addQuestionRow(){
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;';
      row.innerHTML = `<input type="text" class="gr-question-input" placeholder="e.g. Circle the verb: The dog runs fast." style="flex:1;"><button type="button" class="btn small danger">✕</button>`;
      row.querySelector('button').onclick = ()=> row.remove();
      qList.appendChild(row);
    }

    function newWsItem(type){ return { id: newQuestionId(), type: type || 'blank', stem: '', options: ['', ''], correctAnswer: '' }; }

    function wsOptionsHtml(item){
      const opts = (item.options && item.options.length) ? item.options : ['', ''];
      return `<div class="field"><label>Options</label>
        ${opts.map((o,i)=> `<input class="opt-input" data-ws-opt="${item.id}" data-opt-index="${i}" value="${escapeHtml(o)}" placeholder="Option ${i+1}">`).join('')}
        <button type="button" class="btn small" data-ws-addopt="${item.id}">Add option</button></div>`;
    }

    function wsItemRowHtml(item, idx){
      const isMc = item.type === 'mc';
      const isBlank = item.type === 'blank';
      return `<div class="qbuilder-row" data-wsrow="${item.id}">
        <button type="button" class="btn small danger" data-ws-remove="${item.id}">Remove</button>
        <div class="meta" style="margin-bottom:8px;font-weight:700;">Question ${idx + 1}</div>
        <div class="field"><label>Type</label>
          <select data-ws-type="${item.id}">
            <option value="blank" ${isBlank ? 'selected' : ''}>Fill in the blank</option>
            <option value="short" ${item.type === 'short' ? 'selected' : ''}>Short answer</option>
            <option value="mc" ${isMc ? 'selected' : ''}>Multiple choice</option>
          </select>
        </div>
        <div class="field"><label>${isBlank ? 'Sentence — write ___ where the blank goes' : 'Question text'}</label>
          <textarea rows="2" data-ws-stem="${item.id}" placeholder="${isBlank ? 'The dog ___ (run) fast.' : 'What is a noun?'}">${escapeHtml(item.stem)}</textarea>
        </div>
        <div data-ws-options-wrap="${item.id}">${isMc ? wsOptionsHtml(item) : ''}</div>
        <div class="field"><label>Correct answer${isMc ? ' (must exactly match one option above)' : ''} (optional — for your reference)</label>
          <input data-ws-correct="${item.id}" value="${escapeHtml(item.correctAnswer || '')}" placeholder="${isMc ? 'Copy the correct option exactly' : 'e.g. runs'}">
        </div>
      </div>`;
    }

    function syncWsFromDom(){
      wsItems.forEach(item=>{
        const row = document.querySelector(`[data-wsrow="${item.id}"]`);
        if(!row) return;
        item.type = row.querySelector(`[data-ws-type="${item.id}"]`).value;
        item.stem = row.querySelector(`[data-ws-stem="${item.id}"]`).value;
        item.correctAnswer = row.querySelector(`[data-ws-correct="${item.id}"]`).value.trim();
        if(item.type === 'mc'){
          item.options = Array.from(row.querySelectorAll(`[data-ws-opt="${item.id}"]`)).map(i=> i.value.trim());
        }
      });
    }

    function renderWsBuilder(){
      const wrap = document.getElementById('gr-ws-items');
      if(!wrap) return;
      wrap.innerHTML = wsItems.map((it,i)=> wsItemRowHtml(it, i)).join('');
      document.getElementById('gr-ws-add-item').classList.toggle('hidden', wsItems.length === 0);
      wrap.querySelectorAll('[data-ws-remove]').forEach(btn=>{
        btn.onclick = ()=>{ syncWsFromDom(); wsItems = wsItems.filter(x=> x.id !== btn.dataset.wsRemove); renderWsBuilder(); };
      });
      wrap.querySelectorAll('[data-ws-type]').forEach(sel=>{
        sel.onchange = ()=>{
          syncWsFromDom();
          const item = wsItems.find(x=> x.id === sel.dataset.wsType);
          item.type = sel.value;
          if(item.type === 'mc' && (!item.options || item.options.length < 2)) item.options = ['', ''];
          renderWsBuilder();
        };
      });
      wrap.querySelectorAll('[data-ws-addopt]').forEach(btn=>{
        btn.onclick = ()=>{ syncWsFromDom(); const item = wsItems.find(x=> x.id === btn.dataset.wsAddopt); item.options.push(''); renderWsBuilder(); };
      });
    }

    modeSel.onchange = ()=>{
      const isQ = modeSel.value === 'questions';
      const isWs = modeSel.value === 'worksheet';
      qWrap.classList.toggle('hidden', !isQ);
      wsWrap.classList.toggle('hidden', !isWs);
      fileWrap.classList.toggle('hidden', isWs); // worksheet mode uses the PDF itself, not a separate attachment
      instrLabel.textContent = isQ ? 'Instructions (optional)' : (isWs ? 'Instructions (optional)' : 'Instructions / prompt');
      if(isQ && qList.children.length === 0) addQuestionRow();
    };
    document.getElementById('gr-add-question').onclick = addQuestionRow;
    document.getElementById('gr-has-due').onchange = (e)=>{ document.getElementById('gr-due').disabled = !e.target.checked; };
    document.getElementById('gr-cancel').onclick = ()=>{ showNewGrammarForm = false; render(); };

    document.getElementById('gr-ws-extract').onclick = async ()=>{
      const file = document.getElementById('gr-ws-file').files[0];
      const status = document.getElementById('gr-ws-status');
      if(!file){ status.textContent = 'Choose a PDF first.'; return; }
      const extractBtn = document.getElementById('gr-ws-extract');
      extractBtn.disabled = true;
      status.textContent = 'Reading PDF…';
      try{
        const buf = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({
          data: buf,
          cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/standard_fonts/',
          stopAtErrors: false
        }).promise;
        let fullText = '';
        const pagesToRead = Math.min(pdf.numPages, 20);
        for(let i = 1; i <= pagesToRead; i++){
          status.textContent = `Reading page ${i} of ${pagesToRead}…`;
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          fullText += content.items.map(it=> it.str).join(' ') + '\n';
        }
        // A page image (with any figures/photos on it) so the teacher — and
        // later the student — has visual context text extraction can't capture.
        wsPageImage = await pdfPageToDataUrl(pdf, 1, 900);
        document.getElementById('gr-ws-page-preview').innerHTML =
          `<img src="${wsPageImage}" style="max-width:260px;border-radius:8px;border:0.5px solid var(--line);margin:8px 0;display:block;">`;

        const parsed = parseWorksheetText(fullText);
        wsItems = parsed.length ? parsed : [newWsItem()];
        status.textContent = parsed.length
          ? `Found ${parsed.length} question${parsed.length === 1 ? '' : 's'} — review and edit before posting.`
          : `Couldn't auto-detect questions on this file — it may be scanned or handwritten. Use the page image above as reference and add questions manually.`;
        renderWsBuilder();
      }catch(e){
        console.error(e);
        document.getElementById('gr-ws-status').textContent = "Couldn't read that PDF. Try a different file, or add questions manually below.";
        wsItems = wsItems.length ? wsItems : [newWsItem()];
        renderWsBuilder();
      }finally{
        extractBtn.disabled = false;
      }
    };
    document.getElementById('gr-ws-add-item').onclick = ()=>{ syncWsFromDom(); wsItems.push(newWsItem()); renderWsBuilder(); };

    document.getElementById('gr-save').onclick = async ()=>{
      const title = document.getElementById('gr-title').value.trim();
      const err = document.getElementById('gr-error');
      const mode = modeSel.value;
      let questions = [];
      let wsItemsToSave = [];
      if(mode === 'questions'){
        questions = Array.from(qList.querySelectorAll('.gr-question-input'))
          .map(inp=> inp.value.trim()).filter(Boolean)
          .map(text=> ({ id: newQuestionId(), text }));
        if(questions.length === 0){ err.textContent = 'Add at least one question, or switch to single prompt.'; return; }
      }
      if(mode === 'worksheet'){
        syncWsFromDom();
        wsItemsToSave = wsItems
          .map(it=>{
            const item = { id: it.id, type: it.type, stem: it.stem.trim(), correctAnswer: it.correctAnswer || '' };
            if(item.type === 'mc'){
              item.options = (it.options || []).map(o=> o.trim()).filter(Boolean);
              if(item.options.length < 2) item.type = 'short'; // not enough real options — fall back gracefully
            }
            return item;
          })
          .filter(it=> it.stem);
        if(wsItemsToSave.length === 0){ err.textContent = 'Extract or add at least one question before posting.'; return; }
      }
      if(!title){ err.textContent = 'Give the homework a title.'; return; }
      const saveBtn = document.getElementById('gr-save');
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; err.textContent = '';
      try{
        const hasDue = document.getElementById('gr-has-due').checked;
        let attachmentUrl = null;
        let attachmentName = null;
        if(mode === 'worksheet'){
          attachmentUrl = wsPageImage;
          attachmentName = 'worksheet-page-1.jpg';
        }else{
          const file = document.getElementById('gr-file').files[0];
          attachmentUrl = file ? await fileToAttachment(file) : null;
          attachmentName = file ? file.name : null;
        }
        const doc = {
          category,
          mode,
          title,
          instructions: document.getElementById('gr-instr').value.trim(),
          dueDate: hasDue ? (document.getElementById('gr-due').value || addDays(7)) : null,
          attachmentName,
          attachmentUrl,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if(mode === 'questions') doc.questions = questions;
        if(mode === 'worksheet') doc.items = wsItemsToSave;
        await db.collection('classes').doc(classId).collection('homework').add(doc);
        showNewGrammarForm = false;
        render();
      }catch(e){
        saveBtn.disabled = false; saveBtn.textContent = 'Post homework';
        err.textContent = e.message || "Couldn't save — check your connection and try again.";
      }
    };
  }

  viewRoot.querySelectorAll('[data-gr-toggle]').forEach(b=> b.onclick = ()=> toggleGrammarResponses(b.dataset.grToggle));
  viewRoot.querySelectorAll('[data-hw-delete]').forEach(b=> b.onclick = ()=> deleteHomework(b.dataset.hwDelete));
}

// Heuristic PDF-text-to-questions parser. Looks for numbered items
// ("1.", "1)"), then within each item's block looks for either a run of
// underscores (a fill-in blank) or lettered options (A./B)/etc — a
// multiple-choice question). Anything else becomes a short-answer item.
// This is intentionally simple and imperfect — it's a starting point the
// teacher reviews and edits, never posted un-reviewed.
function parseWorksheetText(rawText){
  const lines = rawText.split('\n').map(l=> l.replace(/\s+/g,' ').trim()).filter(Boolean);
  const numberRe = /^(\d{1,2})[\.\)]\s+(.*)$/;
  const mcOptRe = /^\(?([A-Da-d])[\.\)]\s+(.*)$/;
  const blankRe = /_{3,}/;
  const items = [];
  let current = null;

  function pushCurrent(){
    if(!current) return;
    const stemJoined = current.stemParts.join(' ').replace(/\s+/g,' ').trim();
    let type, stem;
    if(current.options.length >= 2){
      type = 'mc';
      stem = stemJoined;
    }else if(blankRe.test(stemJoined)){
      type = 'blank';
      stem = stemJoined.replace(blankRe, '{{blank}}');
    }else{
      type = 'short';
      stem = stemJoined;
    }
    if(stem){
      items.push({
        id: newQuestionId(), type, stem,
        options: current.options.map(o=> o.text),
        correctAnswer: ''
      });
    }
    current = null;
  }

  lines.forEach(line=>{
    const numMatch = line.match(numberRe);
    const optMatch = line.match(mcOptRe);
    if(numMatch){
      pushCurrent();
      current = { stemParts: [numMatch[2]], options: [] };
    }else if(optMatch && current){
      current.options.push({ letter: optMatch[1].toUpperCase(), text: optMatch[2] });
    }else if(current){
      current.stemParts.push(line);
    }
    // lines before the first numbered item (titles, general instructions) are skipped
  });
  pushCurrent();
  return items.slice(0, 40);
}

async function toggleGrammarResponses(hwId){
  const wasExpanded = !!hwResponsesExpanded[hwId];
  hwResponsesExpanded[hwId] = !wasExpanded;
  if(wasExpanded){ render(); return; }
  render(); // shows the "Loading…" placeholder immediately
  const h = homework.find(x=> x.id === hwId);
  const subsSnap = await db.collection('classes').doc(classId).collection('homework').doc(hwId).collection('submissions').get();
  const container = document.getElementById('gr-responses-' + hwId);
  if(!container) return; // user switched tabs before this resolved
  if(subsSnap.empty){ container.innerHTML = '<p class="meta" style="margin-top:10px;">No responses yet.</p>'; return; }
  const docs = [...subsSnap.docs].sort((a,b)=> (a.data().studentName || '').localeCompare(b.data().studentName || ''));
  const isQ = h && h.mode === 'questions';
  const isWs = h && h.mode === 'worksheet';
  let html = '<div style="margin-top:10px;display:flex;flex-direction:column;gap:10px;">';
  docs.forEach(d=>{
    const s = d.data();
    let body;
    let scoreLine = '';
    if(isQ){
      body = `<ol style="margin:6px 0 0;padding-left:18px;">${(h.questions||[]).map(q=> `<li style="margin-bottom:4px;">${escapeHtml(q.text)}<br><span class="body-text">${escapeHtml((s.answers && s.answers[q.id]) || '(no answer)')}</span></li>`).join('')}</ol>`;
    }else if(isWs){
      const score = scoreWorksheetSubmission(h, s.answers);
      if(score.gradable > 0){
        scoreLine = `<span class="meta" style="font-weight:700;color:${score.correct===score.gradable ? 'var(--green-ok)' : 'var(--forest)'};">${score.correct}/${score.gradable} correct</span>`;
      }
      body = `<ol style="margin:6px 0 0;padding-left:18px;">${(h.items||[]).map(it=>{
        const given = (s.answers && s.answers[it.id]) || '';
        const grade = gradeWorksheetItem(it, given);
        const badge = grade === 'correct'
          ? `<span class="stamp submitted" style="margin-left:6px;">✓ correct</span>`
          : grade === 'wrong'
            ? `<span class="stamp overdue" style="margin-left:6px;">✗ incorrect</span>`
            : '';
        const correctNote = (grade === 'wrong' && it.correctAnswer) ? ` <span class="meta">(answer key: ${escapeHtml(it.correctAnswer)})</span>` : '';
        return `<li style="margin-bottom:6px;">${escapeHtml((it.stem||'').replace('{{blank}}','____'))}<br><span class="body-text">${escapeHtml(given || '(no answer)')}</span>${badge}${correctNote}</li>`;
      }).join('')}</ol>`;
    }else{
      body = s.text ? `<p class="body-text" style="white-space:pre-wrap;margin-top:6px;">${escapeHtml(s.text)}</p>` : '<p class="meta" style="margin-top:6px;">(no typed text)</p>';
    }
    html += `<div style="border-top:0.5px solid var(--line);padding-top:10px;">
      <div style="display:flex;justify-content:space-between;gap:10px;"><strong style="font-size:13px;">${escapeHtml(s.studentName)}</strong><span class="meta">attempt ${s.attemptCount || 1} · ${timeAgo(tsVal(s.submittedAt))}${scoreLine ? ' · ' : ''}${scoreLine}</span></div>
      ${body}
      ${s.attachmentUrl ? `<a href="${s.attachmentUrl}" download="${escapeHtml(s.attachmentName || 'file')}" class="meta">📎 ${escapeHtml(s.attachmentName || 'attached file')}</a>` : ''}
    </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

function renderQuizzes(){
  setHeader('Quizzes', 'Build quizzes and see how the class did.');
  let html = `<div class="section-head"><div></div><button class="btn primary small" id="btn-new-quiz">New quiz</button></div>`;

  if(!loaded.quizzes){
    html += `<div class="empty"><h3>Loading quizzes…</h3><p>Connecting to your class.</p></div>`;
    viewRoot.innerHTML = html;
    document.getElementById('btn-new-quiz').onclick = openQuizModal;
    return;
  }

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
      <label class="meta" style="display:flex;align-items:center;gap:6px;margin-top:8px;">
        <input type="checkbox" data-toggle-retake="${q.id}" style="width:auto;" ${q.allowRetake ? 'checked' : ''}> Allow students to retake this quiz
      </label>
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
  viewRoot.querySelectorAll('[data-toggle-retake]').forEach(cb=> cb.onchange = ()=>{
    db.collection('classes').doc(classId).collection('quizzes').doc(cb.dataset.toggleRetake)
      .set({ allowRetake: cb.checked }, { merge: true }).catch(()=> alert("Couldn't update this quiz — check your connection and try again."));
  });
}

function renderBooks(){
  setHeader('Book', 'Upload PDFs for your class to read, with chapters and page navigation.');
  let html = `<div class="section-head"><div></div><button class="btn primary small" id="btn-new-book">Add book</button></div>`;

  if(!loaded.books){
    html += `<div class="empty"><h3>Loading books…</h3><p>Connecting to your class.</p></div>`;
    viewRoot.innerHTML = html;
    document.getElementById('btn-new-book').onclick = openBookUploadModal;
    return;
  }

  if(books.length === 0){
    html += `<div class="empty"><h3>No book materials yet</h3><p>Upload a PDF and students will be able to read it with page navigation and a table of contents.</p></div>`;
    viewRoot.innerHTML = html;
    document.getElementById('btn-new-book').onclick = openBookUploadModal;
    return;
  }

  books.forEach(b=>{
    html += `<div class="card">
      <div class="card-row">
        <div>
          <h3>${escapeHtml(b.title)}</h3>
          <div class="meta">${b.pageCount} page${b.pageCount===1?'':'s'}${b.toc && b.toc.length ? ` · ${b.toc.length} chapter${b.toc.length===1?'':'s'}` : ' · no chapters added'}</div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn small" data-book-view="${b.id}">Read</button>
        <button class="btn small" data-book-toc="${b.id}">Edit chapters</button>
        <button class="btn small danger" data-book-delete="${b.id}">Delete</button>
      </div>
    </div>`;
  });

  viewRoot.innerHTML = html;
  document.getElementById('btn-new-book').onclick = openBookUploadModal;
  viewRoot.querySelectorAll('[data-book-view]').forEach(b=> b.onclick = ()=> openBookViewer(b.dataset.bookView));
  viewRoot.querySelectorAll('[data-book-toc]').forEach(b=> b.onclick = ()=> openBookTocModal(b.dataset.bookToc));
  viewRoot.querySelectorAll('[data-book-delete]').forEach(b=> b.onclick = ()=> deleteBook(b.dataset.bookDelete));
}

function isOnline(p){ return (Date.now() - tsVal(p.lastSeen)) < PRESENCE_ONLINE_MS; }

/* Live drawing is handled entirely by the shared whiteboard.js module
   (window.Whiteboard) — it manages its own canvas + Firestore listeners, so
   we only mount it once and leave it alone on unrelated re-renders (an
   assignment/announcement update elsewhere shouldn't blow away an in-
   progress drawing). */
function renderWhiteboard(){
  setHeader('Whiteboard', 'Draw together in real time with your class — boards are saved automatically for review.');
  if(document.getElementById('wb-page')) return;
  viewRoot.innerHTML = '<div id="wb-page"></div>';
  Whiteboard.mountPage(document.getElementById('wb-page'));
}

function renderStudents(){
  setHeader('Students', 'Who has this class open right now, and when they were last active.');

  if(!loaded.students){
    viewRoot.innerHTML = `<div class="empty"><h3>Loading students…</h3><p>Connecting to your class.</p></div>`;
    return;
  }
  if(presence.length === 0){
    viewRoot.innerHTML = `<div class="empty"><h3>No students have joined yet</h3><p>Once a student opens the class on their device, they'll show up here.</p></div>`;
    return;
  }

  const sorted = [...presence].sort((a,b)=>{
    const aOn = isOnline(a), bOn = isOnline(b);
    if(aOn !== bOn) return aOn ? -1 : 1;
    return tsVal(b.lastSeen) - tsVal(a.lastSeen);
  });
  const onlineCount = sorted.filter(isOnline).length;

  let html = `<p class="meta" style="margin-bottom:14px;">${onlineCount} of ${sorted.length} student${sorted.length===1?'':'s'} online now.</p>`;
  sorted.forEach(p=>{
    const online = isOnline(p);
    html += `<div class="card">
      <div class="card-row" style="align-items:center;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="dot" style="width:9px;height:9px;border-radius:50%;background:${online ? '#5DCAA5' : 'var(--slate-light)'};display:inline-block;flex-shrink:0;"></span>
          <div>
            <div style="font-weight:600;font-size:13px;">${escapeHtml(p.studentName || '(unnamed)')}</div>
            <div class="meta">${online ? 'Online now' : `Last active ${timeAgo(tsVal(p.lastSeen))}`}</div>
          </div>
        </div>
        <button class="btn small primary" data-call="${p.id}" data-name="${escapeHtml(p.studentName || 'this student')}" ${online ? '' : 'disabled'}>
          Video call
        </button>
      </div>
    </div>`;
  });
  viewRoot.innerHTML = html;
  viewRoot.querySelectorAll('[data-call]').forEach(b=> b.onclick = ()=>{
    ClassroomCall.callPerson(b.dataset.call, b.dataset.name);
  });
}


/* --------------------------- 4. ACTIONS --------------------------- */
function statusFor(assignment){
  const overdue = assignment.dueDate && new Date(assignment.dueDate) < new Date(new Date().toDateString());
  if(assignment.submissionCount > 0) return { cls:'submitted', label: overdue ? 'in — was due' : 'submissions in' };
  if(overdue) return { cls:'overdue', label:'overdue' };
  return { cls:'assigned', label:'open' };
}

async function deleteAssignment(id){
  try{
    await db.collection('classes').doc(classId).collection('assignments').doc(id).delete();
  }catch(e){
    alert("Couldn't delete this assignment — check your connection and try again.");
  }
}
async function deleteAnnouncement(id){
  try{
    await db.collection('classes').doc(classId).collection('announcements').doc(id).delete();
  }catch(e){
    alert("Couldn't delete this announcement — check your connection and try again.");
  }
}
async function deleteHomework(id){
  if(!confirm('Delete this homework? Any student submissions will be removed too.')) return;
  try{
    await db.collection('classes').doc(classId).collection('homework').doc(id).delete();
  }catch(e){
    alert("Couldn't delete — check your connection and try again.");
  }
}
async function deleteQuiz(id){
  if(!confirm('Delete this quiz? Student responses to it will no longer be visible.')) return;
  try{
    await db.collection('classes').doc(classId).collection('quizzes').doc(id).delete();
  }catch(e){
    alert("Couldn't delete this quiz — check your connection and try again.");
  }
}
async function deleteBook(id){
  if(!confirm('Delete this book? It will be removed for all students.')) return;
  try{
    const pagesSnap = await db.collection('classes').doc(classId).collection('books').doc(id).collection('pages').get();
    let batch = db.batch(), n = 0;
    for(const d of pagesSnap.docs){
      batch.delete(d.ref);
      n++;
      if(n >= 400){ await batch.commit(); batch = db.batch(); n = 0; }
    }
    if(n > 0) await batch.commit();
    await db.collection('classes').doc(classId).collection('books').doc(id).delete();
  }catch(e){
    alert("Couldn't delete this book — check your connection and try again.");
  }
}

/* --------------------------- 5. MODALS --------------------------- */
function openModal(html, extraClass){
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal${extraClass ? ' ' + extraClass : ''}" role="dialog" aria-modal="true">${html}</div>`;
  bg.addEventListener('click', (e)=>{ if(e.target === bg) closeModal(bg); });
  const onKey = (e)=>{ if(e.key === 'Escape') closeModal(bg); };
  document.addEventListener('keydown', onKey);
  bg._onKey = onKey;
  document.body.appendChild(bg);
  const firstField = bg.querySelector('input, textarea, select, button');
  if(firstField) firstField.focus();
  return bg;
}
function closeModal(bg){
  if(!bg) return;
  if(bg._onKey) document.removeEventListener('keydown', bg._onKey);
  bg.remove();
}

function openHomeworkModal(presetCategory){
  const modal = openModal(`
    <h3>New homework</h3>
    <div class="field"><label>Category</label>
      <select id="hw-category">${HOMEWORK_CATEGORIES.map(c=> `<option value="${c.id}" ${c.id===presetCategory?'selected':''}>${c.label}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Title</label><input id="hw-title" placeholder="Plural nouns worksheet"></div>
    <div class="field"><label>Instructions</label><textarea id="hw-instr" rows="3" placeholder="What should students do?"></textarea></div>
    <div class="field"><label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="hw-has-due" style="width:auto;" checked> Has a due date</label>
      <input id="hw-due" type="date" value="${addDays(7)}">
    </div>
    <div class="field"><label>Attach a file (optional)</label><input id="hw-file" type="file" accept="image/*,.pdf,.doc,.docx"></div>
    <div class="form-actions"><button class="btn" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">Post homework</button></div>
    <div class="gate-error" id="f-error"></div>
  `);
  modal.querySelector('#hw-has-due').onchange = (e)=>{ modal.querySelector('#hw-due').disabled = !e.target.checked; };
  modal.querySelector('#f-cancel').onclick = ()=> closeModal(modal);
  modal.querySelector('#f-save').onclick = async ()=>{
    const title = modal.querySelector('#hw-title').value.trim();
    const err = modal.querySelector('#f-error');
    if(!title){ err.textContent = 'Give the homework a title.'; return; }
    const saveBtn = modal.querySelector('#f-save');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; err.textContent = '';
    try{
      const file = modal.querySelector('#hw-file').files[0];
      const attachmentUrl = file ? await fileToAttachment(file) : null;
      const hasDue = modal.querySelector('#hw-has-due').checked;
      await db.collection('classes').doc(classId).collection('homework').add({
        category: modal.querySelector('#hw-category').value,
        title,
        instructions: modal.querySelector('#hw-instr').value.trim(),
        dueDate: hasDue ? (modal.querySelector('#hw-due').value || addDays(7)) : null,
        attachmentName: file ? file.name : null,
        attachmentUrl,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      closeModal(modal);
    }catch(e){
      saveBtn.disabled = false; saveBtn.textContent = 'Post homework';
      err.textContent = e.message || "Couldn't save — check your connection and try again.";
    }
  };
}

async function openHomeworkReviewModal(hwId){
  const h = homework.find(x=> x.id === hwId);
  const subsSnap = await db.collection('classes').doc(classId).collection('homework').doc(hwId).collection('submissions').get();
  const rows = subsSnap.docs.map(d=>{
    const s = d.data();
    return `<tr>
      <td data-label="Student" style="font-weight:600;">${escapeHtml(s.studentName)}</td>
      <td data-label="Response" class="meta">${escapeHtml(s.text || '(no text)')}${s.attachmentUrl ? ` · <a href="${s.attachmentUrl}" download="${escapeHtml(s.attachmentName || 'file')}">📎 file</a>` : ''}</td>
      <td data-label="Attempts" class="meta">${s.attemptCount || 1}</td>
      <td data-label="When" class="meta">${timeAgo(tsVal(s.submittedAt))}</td>
    </tr>`;
  }).join('');
  const modal = openModal(`
    <h3>Submissions — ${escapeHtml(h ? h.title : '')}</h3>
    ${subsSnap.empty ? '<p class="meta">No submissions yet.</p>' : `<div style="max-height:320px;overflow:auto;"><table class="sub-table" style="width:100%;font-size:13px;border-collapse:collapse;"><thead><tr><th style="text-align:left;padding:6px;">Student</th><th style="text-align:left;padding:6px;">Response</th><th style="text-align:left;padding:6px;">Attempts</th><th style="text-align:left;padding:6px;">When</th></tr></thead><tbody>${rows}</tbody></table></div>`}
    <div class="form-actions"><button class="btn" id="f-close">Close</button></div>
  `);
  modal.querySelector('#f-close').onclick = ()=> closeModal(modal);
}

function openAssignmentModal(){
  const modal = openModal(`
    <h3>New assignment</h3>
    <div class="field"><label>Title</label><input id="f-title" placeholder="Cell structure worksheet"></div>
    <div class="field"><label>Instructions</label><textarea id="f-instr" rows="3" placeholder="What should students do?"></textarea></div>
    <div class="field"><label>Due date</label><input id="f-due" type="date" value="${addDays(3)}"></div>
    <div class="form-actions"><button class="btn" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">Post assignment</button></div>
    <div class="gate-error" id="f-error"></div>
  `);
  modal.querySelector('#f-cancel').onclick = ()=> closeModal(modal);
  modal.querySelector('#f-save').onclick = async ()=>{
    const title = modal.querySelector('#f-title').value.trim();
    if(!title) return;
    const saveBtn = modal.querySelector('#f-save');
    const err = modal.querySelector('#f-error');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Posting…';
    err.textContent = '';
    try{
      await db.collection('classes').doc(classId).collection('assignments').add({
        title,
        instructions: modal.querySelector('#f-instr').value.trim(),
        dueDate: modal.querySelector('#f-due').value || addDays(3),
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      closeModal(modal);
    }catch(e){
      saveBtn.disabled = false;
      saveBtn.textContent = 'Post assignment';
      err.textContent = "Couldn't save — check your connection and try again.";
    }
  };
}

function openAnnouncementModal(){
  const modal = openModal(`
    <h3>New announcement</h3>
    <div class="field"><label>Title</label><input id="f-title" placeholder="Quiz moved to Friday"></div>
    <div class="field"><label>Message</label><textarea id="f-body" rows="3" placeholder="What do you want the class to know?"></textarea></div>
    <div class="form-actions"><button class="btn" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">Post</button></div>
    <div class="gate-error" id="f-error"></div>
  `);
  modal.querySelector('#f-cancel').onclick = ()=> closeModal(modal);
  modal.querySelector('#f-save').onclick = async ()=>{
    const title = modal.querySelector('#f-title').value.trim();
    if(!title) return;
    const saveBtn = modal.querySelector('#f-save');
    const err = modal.querySelector('#f-error');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Posting…';
    err.textContent = '';
    try{
      await db.collection('classes').doc(classId).collection('announcements').add({
        title, body: modal.querySelector('#f-body').value.trim(),
        postedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      closeModal(modal);
    }catch(e){
      saveBtn.disabled = false;
      saveBtn.textContent = 'Post';
      err.textContent = "Couldn't save — check your connection and try again.";
    }
  };
}

async function openReviewModal(assignmentId){
  const subsSnap = await db.collection('classes').doc(classId).collection('assignments').doc(assignmentId).collection('submissions').get();
  const rows = subsSnap.docs.map(d=>{
    const s = d.data();
    return `<tr>
      <td data-label="Student" style="font-weight:600;">${escapeHtml(s.studentName)}</td>
      <td data-label="Response" class="meta">${escapeHtml(s.text || '(no text)')}</td>
      <td data-label="When" class="meta">${timeAgo(tsVal(s.submittedAt))}</td>
    </tr>`;
  }).join('');
  const modal = openModal(`
    <h3>Submissions</h3>
    ${subsSnap.empty ? '<p class="meta">No submissions yet.</p>' : `<div style="max-height:320px;overflow:auto;"><table class="sub-table" style="width:100%;font-size:13px;border-collapse:collapse;"><thead><tr><th style="text-align:left;padding:6px;">Student</th><th style="text-align:left;padding:6px;">Response</th><th style="text-align:left;padding:6px;">When</th></tr></thead><tbody>${rows}</tbody></table></div>`}
    <div class="form-actions"><button class="btn" id="f-close">Close</button></div>
  `);
  modal.querySelector('#f-close').onclick = ()=> closeModal(modal);
}

// Turns any uploaded file into a data-URL suitable for storing on a Firestore
// doc: images get shrunk/compressed via resizeImageToDataUrl; other file
// types (PDF, Word, etc.) are read raw but capped in size since Firestore
// documents max out around 1MB.
function fileToAttachment(file){
  return new Promise((resolve, reject)=>{
    if(file.type && file.type.startsWith('image/')){
      resizeImageToDataUrl(file, 1400, 0.82).then(resolve).catch(reject);
      return;
    }
    if(file.size > 700 * 1024){ reject(new Error('That file is too large — please attach something under 700KB, or a photo/image instead.')); return; }
    const reader = new FileReader();
    reader.onerror = ()=> reject(new Error('Could not read file'));
    reader.onload = ()=> resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

function newQuestionId(){ return 'q' + Math.random().toString(36).slice(2, 10); }

function blankQuestion(){
  return { id: newQuestionId(), type: 'mc', questionText: '', imageUrl: '', options: ['', '', ''], correctAnswer: '', maxAttempts: 3 };
}

// Reads an image file, shrinks it, and returns a compressed data-URL so quiz
// documents stay well under Firestore's 1MB-per-document limit.
function resizeImageToDataUrl(file, maxWidth, quality){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onerror = ()=> reject(new Error('Could not read file'));
    reader.onload = ()=>{
      const img = new Image();
      img.onerror = ()=> reject(new Error('Could not decode image'));
      img.onload = ()=>{
        let { width, height } = img;
        if(width > maxWidth){ height = Math.round(height * (maxWidth / width)); width = maxWidth; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Turns rows from the spreadsheet template into question objects.
function questionsFromSheetRows(rows){
  return rows.map(r=>{
    const rawType = String(r['Type'] || 'mc').trim().toLowerCase();
    const type = rawType === 'text' ? 'text' : 'mc';
    const options = ['Option 1', 'Option 2', 'Option 3', 'Option 4']
      .map(k=> (r[k] === undefined || r[k] === null) ? '' : String(r[k]).trim())
      .filter(o=> o !== '');
    const maxAttempts = parseInt(r['Max Attempts'], 10);
    return {
      id: newQuestionId(),
      type,
      questionText: String(r['Question'] || '').trim(),
      imageUrl: '',
      options: type === 'mc' ? (options.length ? options : ['', '', '']) : [],
      correctAnswer: String(r['Correct Answer'] || '').trim(),
      maxAttempts: (Number.isFinite(maxAttempts) && maxAttempts > 0) ? maxAttempts : 3
    };
  }).filter(q=> q.questionText !== '');
}

function questionRowHtml(q, index){
  const isMc = q.type === 'mc';
  return `<div class="qbuilder-row" data-qrow="${q.id}">
    <button type="button" class="btn small danger remove-q" data-remove-q="${q.id}">Remove</button>
    <div class="meta" style="margin-bottom:8px;font-weight:700;">Question ${index + 1}</div>
    <div class="field"><label>Question text</label><textarea rows="2" data-q-text="${q.id}" placeholder="What is the powerhouse of the cell?">${escapeHtml(q.questionText)}</textarea></div>
    <div class="field"><label>Image (optional)</label>
      ${q.imageUrl ? `<img src="${q.imageUrl}" style="max-width:220px;max-height:140px;border-radius:8px;display:block;margin-bottom:8px;object-fit:contain;">` : ''}
      <input type="file" accept="image/*" data-q-imagefile="${q.id}">
      ${q.imageUrl ? `<button type="button" class="btn small" data-remove-image="${q.id}" style="margin-top:6px;">Remove image</button>` : ''}
      <div class="meta" data-q-imagestatus="${q.id}" style="margin-top:4px;"></div>
    </div>
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
    <div class="form-actions" style="justify-content:flex-start;margin-bottom:14px;">
      <button type="button" class="btn small" id="qz-import-btn">Import from spreadsheet</button>
      <input type="file" id="qz-import-file" accept=".xlsx,.xls,.csv" style="display:none;">
    </div>
    <div id="qz-questions"></div>
    <button type="button" class="btn small" id="qz-add-question">Add question</button>
    <div class="field" style="margin-top:14px;"><label style="display:flex;align-items:center;gap:8px;font-weight:600;"><input type="checkbox" id="qz-allow-retake" style="width:auto;"> Allow students to retake the whole quiz</label>
      <div class="meta" style="margin-top:4px;">If checked, once a student finishes (or runs out of attempts), they get a "Retake quiz" button that clears their answers and lets them start over.</div>
    </div>
    <div class="form-actions"><button class="btn" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">Create quiz</button></div>
  `, 'wide');

  function syncFromDom(){
    builderQuestions.forEach(q=>{
      const row = modal.querySelector(`[data-qrow="${q.id}"]`);
      if(!row) return;
      q.questionText = row.querySelector(`[data-q-text="${q.id}"]`).value;
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
    wrap.querySelectorAll('[data-q-imagefile]').forEach(input=>{
      input.onchange = async ()=>{
        const file = input.files[0];
        if(!file) return;
        const q = builderQuestions.find(x=> x.id === input.dataset.qImagefile);
        const statusEl = wrap.querySelector(`[data-q-imagestatus="${q.id}"]`);
        syncFromDom();
        statusEl.textContent = 'Processing image…';
        try{
          q.imageUrl = await resizeImageToDataUrl(file, 700, 0.72);
        }catch(e){
          alert('Could not read that image. Try a different file.');
        }
        renderBuilder();
      };
    });
    wrap.querySelectorAll('[data-remove-image]').forEach(btn=>{
      btn.onclick = ()=>{
        syncFromDom();
        const q = builderQuestions.find(x=> x.id === btn.dataset.removeImage);
        q.imageUrl = '';
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
  modal.querySelector('#qz-import-btn').onclick = ()=> modal.querySelector('#qz-import-file').click();
  modal.querySelector('#qz-import-file').onchange = ()=>{
    const file = modal.querySelector('#qz-import-file').files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = (evt)=>{
      try{
        const wb = XLSX.read(evt.target.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        const imported = questionsFromSheetRows(rows);
        if(imported.length === 0){ alert("No valid questions found. Make sure the file matches the template (a 'Question' column with text in it)."); return; }
        syncFromDom();
        const isBlankStart = builderQuestions.length === 1 && !builderQuestions[0].questionText.trim();
        builderQuestions = isBlankStart ? imported : builderQuestions.concat(imported);
        renderBuilder();
        alert(`Imported ${imported.length} question${imported.length === 1 ? '' : 's'}. Add images individually if needed, then create the quiz.`);
      }catch(e){
        alert("Could not read that file. Make sure it's a .xlsx, .xls, or .csv file matching the template.");
      }
    };
    reader.readAsArrayBuffer(file);
  };
  modal.querySelector('#f-cancel').onclick = ()=> closeModal(modal);
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
    const estimatedBytes = new Blob([JSON.stringify(builderQuestions)]).size;
    if(estimatedBytes > 900000){
      alert('This quiz is too large to save (likely from full-size images). Remove an image or two, or use smaller photos, and try again.');
      return;
    }
    const saveBtn = modal.querySelector('#f-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try{
      await db.collection('classes').doc(classId).collection('quizzes').add({
        title,
        questions: builderQuestions,
        allowRetake: modal.querySelector('#qz-allow-retake').checked,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      closeModal(modal);
    }catch(e){
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create quiz';
      alert("Couldn't save this quiz — check your connection and try again.");
    }
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
    body = `<div class="table-scroll" style="max-height:360px;overflow:auto;"><table class="scroll-table" style="width:100%;font-size:12px;border-collapse:collapse;">
      <thead><tr><th style="text-align:left;padding:6px;">Student</th>${quiz.questions.map((q, i)=> `<th style="text-align:left;padding:6px;">Q${i + 1}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  const modal = openModal(`<h3>Results — ${escapeHtml(quiz.title)}</h3>${body}<div class="form-actions"><button class="btn" id="f-close">Close</button></div>`);
  modal.querySelector('#f-close').onclick = ()=> closeModal(modal);
}

/* Renders one PDF page to a compressed JPEG data-URL via pdf.js */
async function pdfPageToDataUrl(pdf, pageNum, maxWidth){
  const page = await pdf.getPage(pageNum);
  const unscaled = page.getViewport({ scale: 1 });
  const scale = maxWidth / unscaled.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.72);
}

function openBookUploadModal(){
  const modal = openModal(`
    <h3>Add book material</h3>
    <p class="meta" style="margin-bottom:14px;">Upload a PDF. Each page is converted to an image students can page through — no extra software needed.</p>
    <div class="field"><label>Title</label><input id="bk-title" placeholder="Chapter 4 Reading — Photosynthesis"></div>
    <div class="field"><label>PDF file</label><input id="bk-file" type="file" accept="application/pdf"></div>
    <p class="meta" id="bk-status"></p>
    <div class="form-actions"><button class="btn" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">Upload</button></div>
    <div class="gate-error" id="f-error"></div>
  `, 'wide');
  modal.querySelector('#f-cancel').onclick = ()=> closeModal(modal);
  modal.querySelector('#f-save').onclick = async ()=>{
    const title = modal.querySelector('#bk-title').value.trim();
    const file = modal.querySelector('#bk-file').files[0];
    const err = modal.querySelector('#f-error');
    const status = modal.querySelector('#bk-status');
    const saveBtn = modal.querySelector('#f-save');
    err.textContent = '';
    if(!title){ err.textContent = 'Give the book a title.'; return; }
    if(!file){ err.textContent = 'Choose a PDF file.'; return; }
    saveBtn.disabled = true;
    let bookRef = null;
    let stage = 'reading';
    try{
      status.textContent = 'Reading PDF…';
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({
        data: buf,
        // These let pdf.js handle PDFs with embedded/CJK fonts and non-standard
        // fonts instead of throwing — without them, plenty of ordinary PDFs fail.
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/standard_fonts/',
        stopAtErrors: false // keep going instead of aborting on a single malformed object
      }).promise;
      const pageCount = pdf.numPages;
      if(pageCount > 300){
        err.textContent = `This PDF has ${pageCount} pages — please keep books under 300 pages for now.`;
        saveBtn.disabled = false;
        status.textContent = '';
        return;
      }
      stage = 'saving';
      bookRef = await db.collection('classes').doc(classId).collection('books').add({
        title, pageCount, toc: [], createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      let batch = db.batch();
      let opsInBatch = 0;
      let batchBytes = 0;
      let pagesSaved = 0;
      const MAX_BATCH_BYTES = 8 * 1024 * 1024; // stay safely under Firestore's 10MB batch limit
      for(let i = 1; i <= pageCount; i++){
        status.textContent = `Processing page ${i} of ${pageCount}…`;
        try{
          const dataUrl = await pdfPageToDataUrl(pdf, i, 1100);
          const approxBytes = dataUrl.length; // close enough for a size budget
          if((opsInBatch > 0 && batchBytes + approxBytes > MAX_BATCH_BYTES) || opsInBatch >= 400){
            await batch.commit();
            batch = db.batch();
            opsInBatch = 0;
            batchBytes = 0;
          }
          batch.set(bookRef.collection('pages').doc(String(i).padStart(4,'0')), { index: i, dataUrl });
          opsInBatch++;
          batchBytes += approxBytes;
          pagesSaved++;
        }catch(pageErr){
          // one bad page shouldn't sink the whole book — skip it and keep going
          console.error(`Page ${i} failed to render:`, pageErr);
        }
      }
      if(opsInBatch > 0) await batch.commit();
      if(pagesSaved === 0){
        stage = 'reading';
        throw new Error('No pages could be rendered from this file.');
      }
      closeModal(modal);
    }catch(e){
      console.error(e);
      // clean up a partially-created book so it doesn't show up empty
      if(bookRef){ bookRef.delete().catch(()=>{}); }
      const reason = (e && e.message) ? e.message : 'Unknown error';
      err.textContent = stage === 'saving'
        ? `Couldn't save this book — check your connection and try again. (${reason})`
        : `Couldn't read this PDF (${reason}). Try re-saving/exporting it and uploading again, or use a different file.`;
      saveBtn.disabled = false;
      status.textContent = '';
    }
  };
}

function openBookTocModal(bookId){
  const book = books.find(b=> b.id === bookId);
  if(!book) return;
  let toc = (book.toc || []).map(t=> ({ ...t }));

  function rowsHtml(){
    if(toc.length === 0) return `<p class="book-empty-toc">No chapters yet — add an entry below.</p>`;
    return toc.map((t,i)=> `
      <div class="qbuilder-row">
        <button class="btn small danger remove-q" data-remove-toc="${i}">✕</button>
        <div class="field"><label>Chapter / section title</label><input data-toc-title="${i}" value="${escapeHtml(t.title||'')}" placeholder="Chapter 2 — Cell Structure"></div>
        <div class="field" style="max-width:160px;"><label>Starts on page</label><input type="number" min="1" max="${book.pageCount}" data-toc-page="${i}" value="${t.page || 1}"></div>
      </div>`).join('');
  }

  const modal = openModal(`
    <h3>Table of contents — ${escapeHtml(book.title)}</h3>
    <p class="meta">Add entries so students can jump straight to a chapter or section.</p>
    <div id="toc-rows">${rowsHtml()}</div>
    <button class="btn small" id="toc-add" style="margin-bottom:10px;">Add entry</button>
    <div class="form-actions"><button class="btn" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">Save</button></div>
    <div class="gate-error" id="f-error"></div>
  `, 'wide');

  function sync(){
    modal.querySelectorAll('[data-toc-title]').forEach(inp=> toc[+inp.dataset.tocTitle].title = inp.value);
    modal.querySelectorAll('[data-toc-page]').forEach(inp=> toc[+inp.dataset.tocPage].page = Math.max(1, Math.min(book.pageCount, +inp.value || 1)));
  }
  function wire(){
    modal.querySelectorAll('[data-remove-toc]').forEach(btn=>{
      btn.onclick = ()=>{ sync(); toc.splice(+btn.dataset.removeToc, 1); rerender(); };
    });
  }
  function rerender(){
    modal.querySelector('#toc-rows').innerHTML = rowsHtml();
    wire();
  }
  wire();

  modal.querySelector('#toc-add').onclick = ()=>{ sync(); toc.push({ title:'', page:1 }); rerender(); };
  modal.querySelector('#f-cancel').onclick = ()=> closeModal(modal);
  modal.querySelector('#f-save').onclick = async ()=>{
    sync();
    const clean = toc.filter(t=> t.title.trim() !== '').sort((a,b)=> a.page - b.page);
    const saveBtn = modal.querySelector('#f-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try{
      await db.collection('classes').doc(classId).collection('books').doc(bookId).update({ toc: clean });
      closeModal(modal);
    }catch(e){
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      modal.querySelector('#f-error').textContent = "Couldn't save — check your connection and try again.";
    }
  };
}

/* Full-screen book reader: table of contents, prev/next paging, zoom, and
   personal bookmarks with notes. Shared shape between teacher and student. */
async function openBookViewer(bookId){
  const book = books.find(b=> b.id === bookId);
  if(!book) return;
  const ownerId = 'teacher'; // one teacher identity per class for bookmarks
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
  modal.querySelector('#bv-close').onclick = ()=>{ document.removeEventListener('keydown', keyHandler); closeModal(modal); };

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
      await bookmarksRef.set({ items: bookmarks });
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
          <div class="meta" style="margin:16px 0 8px;font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:.04em;">Bookmarks</div>
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
    wireSwipe(body.querySelector('.book-page-wrap'));
  }

  // Touch swipe left/right to flip pages (mobile/trackpad-friendly).
  function wireSwipe(el){
    if(!el) return;
    let startX = 0, startY = 0, tracking = false;
    el.addEventListener('touchstart', (e)=>{
      if(e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });
    el.addEventListener('touchend', (e)=>{
      if(!tracking) return;
      tracking = false;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const SWIPE_THRESHOLD = 50;
      if(Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)){
        if(dx < 0) go(pageNum + 1); else go(pageNum - 1);
      }
    }, { passive: true });
  }

  renderBody();
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
  btn.addEventListener('click', ()=>{
    if(currentView === 'whiteboard' && btn.dataset.view !== 'whiteboard'){
      const wbPage = document.getElementById('wb-page');
      if(wbPage && wbPage._wbTeardown) wbPage._wbTeardown();
    }
    currentView = btn.dataset.view; render();
  });
});
/* Note: the "leave/remove class" and "add another class" controls live in
   the sidebar's class-switcher box, which is rebuilt by renderClassSwitcher()
   on every startApp()/switchToClass() call, so they're wired there instead. */

/* Presence timestamps only change on the student's next heartbeat, so
   without this, someone who closes their tab would still show "online"
   until an unrelated Firestore update happened to trigger a re-render. */
setInterval(()=>{
  if(currentView === 'students' || currentView === 'dashboard') render();
}, 15000);

/* --------------------------- 8. INIT --------------------------- */
initGate();