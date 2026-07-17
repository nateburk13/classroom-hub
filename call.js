/* =========================================================================
   CLASSROOM CALL — shared 1:1 video/audio calling module.
   Used by both teacher.html and student.html. Anyone marked "online" in the
   class's `presence` collection can call anyone else. Signaling (offer /
   answer / ICE candidates) goes through Firestore under
   classes/{classId}/calls/{callId}; the actual audio/video is peer-to-peer
   WebRTC, so it doesn't touch your Firestore quota once connected.

   Public API (attached to window.ClassroomCall):
     init({ classId, myId, myName, myRole })  — call after you know who you are
     teardown()                               — call when leaving/switching class
   ========================================================================= */
(function(){
  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];
  const ONLINE_WINDOW_MS = 60000; // matches the presence heartbeat elsewhere
  const RING_TIMEOUT_MS = 30000;

  let ctx = null;                  // { classId, myId, myName, myRole }
  let others = [];                 // online people I could call, minus myself
  let unsubPresence = null;
  let unsubIncoming = null;
  let unsubCallDoc = null;
  let unsubTheirCandidates = null;

  let pc = null;
  let localStream = null;
  let callDocRef = null;
  let inCallWith = null;           // { id, name }
  let callRoleInCall = null;       // 'caller' | 'callee'
  let ringTimer = null;

  let root, fabBtn, fabBadge, panelEl, incomingEl, bubbleEl, localVideoEl, remoteVideoEl;
  let dragState = null;

  function el(html){ const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(str){ const d = document.createElement('div'); d.textContent = str ?? ''; return d.innerHTML; }
  function tsVal(ts){ return ts && ts.toMillis ? ts.toMillis() : (ts || 0); }
  function isOnline(p){ return (Date.now() - tsVal(p.lastSeen)) < ONLINE_WINDOW_MS; }
  function callsCol(){ return db.collection('classes').doc(ctx.classId).collection('calls'); }

  /* --------------------------- DOM shell --------------------------- */
  function ensureRoot(){
    if(root) return;
    root = document.createElement('div');
    root.id = 'cc-root';
    document.body.appendChild(root);

    fabBtn = el(`
      <button id="cc-fab" class="cc-fab" title="Start a call">
        <span class="cc-fab-icon">\u{1F4DE}</span>
        <span id="cc-fab-badge" class="cc-fab-badge hidden">0</span>
      </button>`);
    fabBtn.addEventListener('click', togglePanel);
    root.appendChild(fabBtn);

    panelEl = el(`<div id="cc-panel" class="cc-panel hidden"></div>`);
    root.appendChild(panelEl);

    incomingEl = el(`<div id="cc-incoming" class="cc-incoming hidden"></div>`);
    root.appendChild(incomingEl);

    bubbleEl = el(`
      <div id="cc-bubble" class="cc-bubble hidden">
        <video id="cc-remote-video" class="cc-remote-video" autoplay playsinline></video>
        <video id="cc-local-video" class="cc-local-video" autoplay playsinline muted></video>
        <div class="cc-bubble-status" id="cc-bubble-status"></div>
        <div class="cc-bubble-controls">
          <button class="cc-ctrl" id="cc-toggle-mic" title="Mute / unmute">\u{1F3A4}</button>
          <button class="cc-ctrl" id="cc-toggle-cam" title="Camera on / off">\u{1F4F9}</button>
          <button class="cc-ctrl cc-ctrl-min" id="cc-minimize" title="Minimize">\u2014</button>
          <button class="cc-ctrl cc-ctrl-end" id="cc-hangup" title="Hang up">\u2715</button>
        </div>
      </div>`);
    root.appendChild(bubbleEl);
    localVideoEl = bubbleEl.querySelector('#cc-local-video');
    remoteVideoEl = bubbleEl.querySelector('#cc-remote-video');

    bubbleEl.querySelector('#cc-hangup').addEventListener('click', ()=> endCall('ended'));
    bubbleEl.querySelector('#cc-minimize').addEventListener('click', toggleMinimize);
    bubbleEl.querySelector('#cc-toggle-mic').addEventListener('click', toggleMic);
    bubbleEl.querySelector('#cc-toggle-cam').addEventListener('click', toggleCam);
    makeDraggable(bubbleEl);
  }

  function togglePanel(){
    if(!panelEl) return;
    if(panelEl.classList.contains('hidden')) renderPanel();
    panelEl.classList.toggle('hidden');
  }

  function renderPanel(){
    const list = others.filter(isOnline);
    let html = `<div class="cc-panel-head">Call someone</div>`;
    if(list.length === 0){
      html += `<div class="cc-panel-empty">No one else is online right now.</div>`;
    }else{
      list.forEach(p=>{
        html += `<div class="cc-panel-row">
          <span class="cc-dot-online"></span>
          <span class="cc-panel-name">${esc(p.name)}${p.role === 'teacher' ? ' <span class="cc-tag">Teacher</span>' : ''}</span>
          <button class="cc-panel-call" data-call="${esc(p.id)}">\u{1F4DE}</button>
        </div>`;
      });
    }
    panelEl.innerHTML = html;
    panelEl.querySelectorAll('[data-call]').forEach(btn=>{
      btn.onclick = ()=>{
        const target = list.find(p=> p.id === btn.dataset.call);
        if(target){ panelEl.classList.add('hidden'); startCall(target); }
      };
    });
  }

  function updateBadge(){
    if(!fabBadge) return;
    const count = others.filter(isOnline).length;
    fabBadge.textContent = count;
    fabBadge.classList.toggle('hidden', count === 0);
  }

  /* --------------------------- presence (who can I call) --------------------------- */
  function watchPresence(){
    unsubPresence = db.collection('classes').doc(ctx.classId).collection('presence')
      .onSnapshot(snap=>{
        others = snap.docs
          .filter(d=> d.id !== ctx.myId)
          .map(d=>{
            const data = d.data();
            return {
              id: d.id,
              name: data.role === 'teacher' ? (data.name || 'Teacher') : (data.studentName || data.name || 'Student'),
              role: data.role || 'student',
              lastSeen: data.lastSeen
            };
          });
        updateBadge();
        if(panelEl && !panelEl.classList.contains('hidden')) renderPanel();
      }, ()=>{ /* presence is best-effort for calling; ignore errors here */ });
  }

  /* --------------------------- incoming calls --------------------------- */
  function watchIncoming(){
    unsubIncoming = callsCol().where('calleeId','==', ctx.myId)
      .onSnapshot(snap=>{
        snap.docChanges().forEach(change=>{
          if(change.type !== 'added' && change.type !== 'modified') return;
          const data = change.doc.data();
          if(data.status !== 'ringing') return;
          if(inCallWith || callDocRef){ // already busy — auto-decline
            callsCol().doc(change.doc.id).update({ status: 'declined' }).catch(()=>{});
            return;
          }
          showIncoming(change.doc.id, data);
        });
      }, ()=>{});
  }

  function showIncoming(callId, data){
    incomingEl.innerHTML = `
      <div class="cc-incoming-card">
        <div class="cc-incoming-title">${esc(data.callerName || 'Someone')} is calling\u2026</div>
        <div class="cc-incoming-actions">
          <button class="btn primary" id="cc-accept">Accept</button>
          <button class="btn danger" id="cc-decline">Decline</button>
        </div>
      </div>`;
    incomingEl.classList.remove('hidden');
    incomingEl.querySelector('#cc-decline').onclick = ()=>{
      incomingEl.classList.add('hidden');
      callsCol().doc(callId).update({ status: 'declined' }).catch(()=>{});
    };
    incomingEl.querySelector('#cc-accept').onclick = async ()=>{
      incomingEl.classList.add('hidden');
      await acceptCall(callId, data);
    };
  }

  /* --------------------------- outgoing call --------------------------- */
  async function startCall(target){
    if(inCallWith || callDocRef) return; // already on a call
    try{
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }catch(e){
      alert("Couldn't access your camera/microphone. Check your browser's permissions and try again.");
      return;
    }
    inCallWith = { id: target.id, name: target.name };
    callRoleInCall = 'caller';
    pc = buildPeerConnection();
    localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));
    showBubble(`Calling ${target.name}\u2026`);

    callDocRef = callsCol().doc();
    pc.onicecandidate = e=>{ if(e.candidate) callDocRef.collection('callerCandidates').add(e.candidate.toJSON()).catch(()=>{}); };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await callDocRef.set({
      callerId: ctx.myId, callerName: ctx.myName,
      calleeId: target.id, calleeName: target.name,
      offer: { type: offer.type, sdp: offer.sdp },
      status: 'ringing',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    ringTimer = setTimeout(()=>{
      if(callDocRef && callRoleInCall === 'caller'){
        callDocRef.update({ status: 'missed' }).catch(()=>{});
        endCall(null, 'No answer.');
      }
    }, RING_TIMEOUT_MS);

    unsubCallDoc = callDocRef.onSnapshot(async doc=>{
      const data = doc.data();
      if(!data) return;
      if(data.answer && pc && !pc.currentRemoteDescription){
        clearTimeout(ringTimer);
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        showBubble(`In call with ${target.name}`);
      }
      if(data.status === 'declined'){ endCall(null, `${target.name} declined the call.`); }
      if(data.status === 'ended'){ endCall(null); }
    });

    unsubTheirCandidates = callDocRef.collection('calleeCandidates').onSnapshot(snap=>{
      snap.docChanges().forEach(change=>{
        if(change.type === 'added' && pc) pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(()=>{});
      });
    });
  }

  /* --------------------------- incoming acceptance --------------------------- */
  async function acceptCall(callId, data){
    if(inCallWith || callDocRef) return;
    try{
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }catch(e){
      alert("Couldn't access your camera/microphone. Check your browser's permissions and try again.");
      callsCol().doc(callId).update({ status: 'declined' }).catch(()=>{});
      return;
    }
    inCallWith = { id: data.callerId, name: data.callerName };
    callRoleInCall = 'callee';
    callDocRef = callsCol().doc(callId);
    pc = buildPeerConnection();
    localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));
    showBubble(`In call with ${data.callerName}`);

    pc.onicecandidate = e=>{ if(e.candidate) callDocRef.collection('calleeCandidates').add(e.candidate.toJSON()).catch(()=>{}); };

    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await callDocRef.update({ answer: { type: answer.type, sdp: answer.sdp }, status: 'active' });

    unsubCallDoc = callDocRef.onSnapshot(doc=>{
      const d = doc.data();
      if(d && d.status === 'ended') endCall(null);
    });
    unsubTheirCandidates = callDocRef.collection('callerCandidates').onSnapshot(snap=>{
      snap.docChanges().forEach(change=>{
        if(change.type === 'added' && pc) pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(()=>{});
      });
    });
  }

  /* --------------------------- shared peer connection --------------------------- */
  function buildPeerConnection(){
    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    conn.ontrack = e=>{
      if(remoteVideoEl.srcObject !== e.streams[0]) remoteVideoEl.srcObject = e.streams[0];
    };
    conn.onconnectionstatechange = ()=>{
      if(['disconnected','failed','closed'].includes(conn.connectionState)) endCall(null);
    };
    return conn;
  }

  function endCall(setStatus, note){
    clearTimeout(ringTimer);
    if(setStatus && callDocRef) callDocRef.update({ status: setStatus }).catch(()=>{});
    else if(callDocRef) callDocRef.update({ status: 'ended' }).catch(()=>{});
    if(unsubCallDoc){ unsubCallDoc(); unsubCallDoc = null; }
    if(unsubTheirCandidates){ unsubTheirCandidates(); unsubTheirCandidates = null; }
    if(pc){ pc.close(); pc = null; }
    if(localStream){ localStream.getTracks().forEach(t=> t.stop()); localStream = null; }
    if(localVideoEl) localVideoEl.srcObject = null;
    if(remoteVideoEl) remoteVideoEl.srcObject = null;
    callDocRef = null;
    inCallWith = null;
    callRoleInCall = null;
    hideBubble();
    if(note) setTimeout(()=> alert(note), 50);
  }

  /* --------------------------- bubble UI --------------------------- */
  function showBubble(status){
    bubbleEl.classList.remove('hidden', 'cc-bubble-min');
    bubbleEl.querySelector('#cc-bubble-status').textContent = status;
    if(localVideoEl) localVideoEl.srcObject = localStream;
  }
  function hideBubble(){ bubbleEl.classList.add('hidden'); }
  function toggleMinimize(){ bubbleEl.classList.toggle('cc-bubble-min'); }
  function toggleMic(){
    if(!localStream) return;
    localStream.getAudioTracks().forEach(t=> t.enabled = !t.enabled);
    const on = localStream.getAudioTracks()[0] ? localStream.getAudioTracks()[0].enabled : true;
    bubbleEl.querySelector('#cc-toggle-mic').classList.toggle('cc-ctrl-off', !on);
  }
  function toggleCam(){
    if(!localStream) return;
    localStream.getVideoTracks().forEach(t=> t.enabled = !t.enabled);
    const on = localStream.getVideoTracks()[0] ? localStream.getVideoTracks()[0].enabled : true;
    bubbleEl.querySelector('#cc-toggle-cam').classList.toggle('cc-ctrl-off', !on);
  }

  function makeDraggable(node){
    node.addEventListener('pointerdown', e=>{
      if(e.target.closest('.cc-ctrl')) return; // don't drag when tapping a control
      const rect = node.getBoundingClientRect();
      dragState = { offX: e.clientX - rect.left, offY: e.clientY - rect.top };
      node.setPointerCapture(e.pointerId);
      node.style.right = 'auto'; node.style.bottom = 'auto';
      node.style.left = rect.left + 'px'; node.style.top = rect.top + 'px';
    });
    node.addEventListener('pointermove', e=>{
      if(!dragState) return;
      const w = node.offsetWidth, h = node.offsetHeight;
      let left = e.clientX - dragState.offX;
      let top = e.clientY - dragState.offY;
      left = Math.max(4, Math.min(window.innerWidth - w - 4, left));
      top = Math.max(4, Math.min(window.innerHeight - h - 4, top));
      node.style.left = left + 'px'; node.style.top = top + 'px';
    });
    ['pointerup','pointercancel'].forEach(evt=> node.addEventListener(evt, ()=>{ dragState = null; }));
  }

  /* --------------------------- public API --------------------------- */
  function init(newCtx){
    teardown(); // clean slate if switching identity/class
    ctx = newCtx;
    ensureRoot();
    fabBadge = document.getElementById('cc-fab-badge');
    fabBtn.classList.remove('hidden');
    watchPresence();
    watchIncoming();
  }

  function teardown(){
    if(unsubPresence){ unsubPresence(); unsubPresence = null; }
    if(unsubIncoming){ unsubIncoming(); unsubIncoming = null; }
    if(callDocRef || pc) endCall('ended');
    others = [];
    if(fabBtn) fabBtn.classList.add('hidden');
    if(panelEl) panelEl.classList.add('hidden');
    if(incomingEl) incomingEl.classList.add('hidden');
    ctx = null;
  }

  window.ClassroomCall = { init, teardown };
})();
