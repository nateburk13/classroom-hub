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
      <p>This creates a join code your students will use to see assignments and announcements in real time.</p>
      <div class="field"><label>Class name</label><input id="g-class" placeholder="Period 3 — Biology"></div>
      <div class="field"><label>Your name</label><input id="g-teacher" placeholder="Ms. Alvarez"></div>
      <button class="btn primary" id="g-submit" style="width:100%;">Create class</button>
      <div class="gate-error" id="g-error"></div>
    </div>`;
  document.getElementById('g-submit').onclick = async ()=>{
    const className = document.getElementById('g-class').value.trim();
    const teacherName = document.getElementById('g-teacher').value.trim();
    const err = document.getElementById('g-error');
    if(!className || !teacherName){ err.textContent = 'Fill in both fields to continue.'; return; }
    err.textContent = 'Creating class…';
    try{
      const code = makeClassCode();
      const ref = await db.collection('classes').add({
        className, teacherName, code, createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      localStorage.setItem(LS_CLASS_ID, ref.id);
      const doc = await ref.get();
      startApp(ref.id, doc.data());
    }catch(e){
      err.textContent = 'Could not reach the database. Check firebase-config.js is filled in correctly.';
    }
  };
}

/* --------------------------- 2. STATE --------------------------- */
let classId = null;
let classInfo = null;
let currentView = 'dashboard';
let unsubAssignments = null;
let unsubAnnouncements = null;
let assignments = [];
let announcements = [];

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
  const renderers = { dashboard: renderDashboard, assignments: renderAssignments, announcements: renderAnnouncements };
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
