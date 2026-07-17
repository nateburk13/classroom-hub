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
  if(unsubPresence) unsubPresence();
  unsubAssignments = unsubAnnouncements = unsubQuizzes = unsubBooks = unsubPresence = null;
  stopTeacherPresence();
  ClassroomCall.teardown();
  cleanupCallLocal();
  assignments = []; announcements = []; quizzes = []; books = []; presence = [];
  loaded = { assignments: false, announcements: false, quizzes: false, books: false, students: false };
}

/* --------------------------- 2. STATE --------------------------- */
let classId = null;
let classInfo = null;
let currentView = 'dashboard';
let unsubAssignments = null;
let unsubAnnouncements = null;
let unsubQuizzes = null;
let unsubBooks = null;
let assignments = [];
let announcements = [];
let quizzes = [];
let books = [];
let presence = [];
let unsubPresence = null;
let loaded = { assignments: false, announcements: false, quizzes: false, books: false, students: false };
const PRESENCE_ONLINE_MS = 60000; // no heartbeat within this window = shown offline
const TEACHER_PRESENCE_ID = '__teacher__';
let teacherPresenceInterval = null;
const PRESENCE_HEARTBEAT_MS = 25000;

/* ---- Live video/audio calls (WebRTC, signaled through Firestore) ----
   STUN-only config below works for most home/mobile networks. Some school
   networks block peer-to-peer traffic entirely; if calls consistently fail
   to connect (stuck on "Calling…"), you'd need to add a TURN server here —
   ask me and I can help wire one in. */
const RTC_CONFIG = { iceServers: [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
] };
let pc = null;
let localStream = null;
let activeCallId = null;   // the studentId this call is with
let unsubCall = null;
let unsubRemoteCandidates = null;

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
    .catch(()=>{});
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
  const renderers = { dashboard: renderDashboard, assignments: renderAssignments, announcements: renderAnnouncements, quizzes: renderQuizzes, books: renderBooks, students: renderStudents };
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
    const inThisCall = activeCallId === p.id;
    html += `<div class="card">
      <div class="card-row" style="align-items:center;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="dot" style="width:9px;height:9px;border-radius:50%;background:${online ? '#5DCAA5' : 'var(--slate-light)'};display:inline-block;flex-shrink:0;"></span>
          <div>
            <div style="font-weight:600;font-size:13px;">${escapeHtml(p.studentName || '(unnamed)')}</div>
            <div class="meta">${online ? 'Online now' : `Last active ${timeAgo(tsVal(p.lastSeen))}`}</div>
          </div>
        </div>
        <button class="btn small ${inThisCall ? 'danger' : 'primary'}" data-call="${p.id}" data-name="${escapeHtml(p.studentName || 'this student')}" ${activeCallId && !inThisCall ? 'disabled' : ''}>
          ${inThisCall ? 'End call' : (online ? 'Video call' : 'Call (offline)')}
        </button>
      </div>
    </div>`;
  });
  viewRoot.innerHTML = html;
  viewRoot.querySelectorAll('[data-call]').forEach(b=> b.onclick = ()=>{
    if(activeCallId === b.dataset.call){ endCall(); return; }
    startCall(b.dataset.call, b.dataset.name);
  });
}

/* --------------------------- 3b. VIDEO CALLS --------------------------- */
async function startCall(studentId, studentName){
  if(pc){ alert('You are already in a call — end it before starting another.'); return; }
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }catch(e){ alert('Could not access your camera/microphone. Check browser permissions and try again.'); return; }

  activeCallId = studentId;
  render(); // reflect "End call" button state immediately
  const callRef = db.collection('classes').doc(classId).collection('calls').doc(studentId);

  pc = new RTCPeerConnection(RTC_CONFIG);
  localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));
  showCallWidget(studentName, true);

  const remoteStream = new MediaStream();
  const remoteVideo = document.getElementById('call-remote-video');
  if(remoteVideo) remoteVideo.srcObject = remoteStream;
  pc.ontrack = (e)=>{ e.streams[0].getTracks().forEach(t=> remoteStream.addTrack(t)); };
  pc.onconnectionstatechange = ()=>{
    if(pc && pc.connectionState === 'connected') setCallStatus('Connected');
    if(pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) setCallStatus('Connection lost…');
  };

  const offerCandidates = callRef.collection('offerCandidates');
  const answerCandidates = callRef.collection('answerCandidates');
  pc.onicecandidate = (e)=>{ if(e.candidate) offerCandidates.add(e.candidate.toJSON()); };

  const offerDesc = await pc.createOffer();
  await pc.setLocalDescription(offerDesc);
  await callRef.set({
    from: 'teacher', fromName: classInfo.teacherName, toId: studentId, toName: studentName,
    offer: { sdp: offerDesc.sdp, type: offerDesc.type }, status: 'ringing',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  unsubCall = callRef.onSnapshot(async (snap)=>{
    const data = snap.data();
    if(!data){ endCall(); return; }
    if(data.status === 'declined'){ setCallStatus('Call declined.'); setTimeout(endCall, 1500); return; }
    if(data.status === 'ended'){ endCall(); return; }
    if(data.answer && pc && !pc.currentRemoteDescription){
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  });
  unsubRemoteCandidates = answerCandidates.onSnapshot((snap)=>{
    snap.docChanges().forEach(change=>{
      if(change.type === 'added' && pc) pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(()=>{});
    });
  });
}

function cleanupCallLocal(){
  if(unsubCall){ unsubCall(); unsubCall = null; }
  if(unsubRemoteCandidates){ unsubRemoteCandidates(); unsubRemoteCandidates = null; }
  if(pc){ pc.close(); pc = null; }
  if(localStream){ localStream.getTracks().forEach(t=> t.stop()); localStream = null; }
  hideCallWidget();
  activeCallId = null;
}

async function endCall(){
  const wasId = activeCallId;
  const wasClassId = classId;
  cleanupCallLocal();
  render();
  if(wasId){
    try{ await db.collection('classes').doc(wasClassId).collection('calls').doc(wasId).update({ status: 'ended' }); }catch(e){}
  }
}

function showCallWidget(peerName, isCaller){
  let widget = document.getElementById('call-widget');
  if(!widget){
    widget = document.createElement('div');
    widget.id = 'call-widget';
    widget.className = 'call-widget';
    widget.innerHTML = `
      <div class="call-widget-head" id="call-widget-head">
        <span id="call-widget-title"></span>
        <button class="call-icon-btn" id="call-minimize" title="Minimize">–</button>
      </div>
      <div class="call-widget-body">
        <video id="call-remote-video" autoplay playsinline></video>
        <video id="call-local-video" autoplay playsinline muted></video>
        <div class="call-status" id="call-status"></div>
        <div class="call-controls">
          <button class="btn small" id="call-toggle-mic">Mute</button>
          <button class="btn small" id="call-toggle-cam">Camera off</button>
          <button class="btn small danger" id="call-end">End call</button>
        </div>
      </div>`;
    document.body.appendChild(widget);
    makeCallWidgetDraggable(widget, document.getElementById('call-widget-head'));
    document.getElementById('call-end').onclick = ()=> endCall();
    document.getElementById('call-toggle-mic').onclick = toggleCallMic;
    document.getElementById('call-toggle-cam').onclick = toggleCallCam;
    document.getElementById('call-minimize').onclick = ()=> widget.classList.toggle('minimized');
  }
  document.getElementById('call-widget-title').textContent = `Call with ${peerName}`;
  setCallStatus(isCaller ? 'Calling…' : 'Connecting…');
  widget.classList.remove('minimized');
  const localVideo = document.getElementById('call-local-video');
  if(localVideo) localVideo.srcObject = localStream;
}
function hideCallWidget(){ const w = document.getElementById('call-widget'); if(w) w.remove(); }
function setCallStatus(text){ const el = document.getElementById('call-status'); if(el) el.textContent = text; }
function toggleCallMic(){
  if(!localStream) return;
  const track = localStream.getAudioTracks()[0]; if(!track) return;
  track.enabled = !track.enabled;
  document.getElementById('call-toggle-mic').textContent = track.enabled ? 'Mute' : 'Unmute';
}
function toggleCallCam(){
  if(!localStream) return;
  const track = localStream.getVideoTracks()[0]; if(!track) return;
  track.enabled = !track.enabled;
  document.getElementById('call-toggle-cam').textContent = track.enabled ? 'Camera off' : 'Camera on';
}
function makeCallWidgetDraggable(el, handle){
  let offX = 0, offY = 0, dragging = false;
  handle.addEventListener('pointerdown', (e)=>{
    dragging = true;
    const rect = el.getBoundingClientRect();
    offX = e.clientX - rect.left; offY = e.clientY - rect.top;
    el.style.right = 'auto'; el.style.bottom = 'auto';
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e)=>{
    if(!dragging) return;
    el.style.left = Math.min(window.innerWidth - 60, Math.max(0, e.clientX - offX)) + 'px';
    el.style.top = Math.min(window.innerHeight - 40, Math.max(0, e.clientY - offY)) + 'px';
  });
  handle.addEventListener('pointerup', ()=>{ dragging = false; });
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
  btn.addEventListener('click', ()=>{ currentView = btn.dataset.view; render(); });
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