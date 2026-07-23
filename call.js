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
  // STUN alone only works when both sides can be reached directly; many
  // school/mobile networks block that, so calls connect briefly then die.
  // The TURN entries below (Open Relay Project's free public TURN service)
  // relay the media instead, as a fallback when direct P2P isn't possible.
  // Free/shared, so treat it as a stopgap — for heavier use, swap in your
  // own TURN credentials (e.g. Twilio, Cloudflare, or a self-hosted coturn).
  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
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

  // ------- screen share -------
  let screenStream = null;
  let cameraTrack = null;          // original camera track, kept so we can restore it
  let isScreenSharing = false;

  // ------- expand / enlarge -------
  let isExpanded = false;

  // ------- remote-control data channel -------
  // Lets the *viewer* of a shared screen relay clicks/keystrokes back to the
  // sharer, who replays them on their own page. This only ever touches the
  // Classroom Hub page itself (via document.elementFromPoint + synthetic
  // events) — a browser cannot hand a webpage real OS-level control of
  // someone else's mouse/keyboard, so this is intentionally scoped to
  // controlling the shared page rather than pretending to be a full
  // remote-desktop tool. Works best when the sharer picks "This Tab".
  let controlChannel = null;
  let controlChannelOpen = false;
  let iAmSharingAndGrantedControl = false;  // I'm sharing my screen and let them drive
  let iAmControllingThem = false;           // I've been granted control of their screen
  let controlRequestEl = null;

  function el(html){ const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(str){ const d = document.createElement('div'); d.textContent = str ?? ''; return d.innerHTML; }
  function tsVal(ts){ return ts && ts.toMillis ? ts.toMillis() : (ts || 0); }
  function isOnline(p){ return (Date.now() - tsVal(p.lastSeen)) < ONLINE_WINDOW_MS; }
  function callsCol(){ return db.collection('classes').doc(ctx.classId).collection('calls'); }

  /* --------------------------- ringtone --------------------------- */
  let ringAudioCtx = null;
  let ringInterval = null;
  let ringOscillators = [];
  function playRingtoneChirp(){
    try{
      ringAudioCtx = ringAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = ringAudioCtx.currentTime;
      [0, 0.18].forEach(offset=>{
        const osc = ringAudioCtx.createOscillator();
        const gain = ringAudioCtx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.15);
        osc.connect(gain); gain.connect(ringAudioCtx.destination);
        osc.start(now + offset); osc.stop(now + offset + 0.16);
      });
    }catch(e){ /* audio not available — silently skip the tone */ }
  }
  function startRinging(){
    stopRinging();
    playRingtoneChirp();
    ringInterval = setInterval(playRingtoneChirp, 1600);
    if(navigator.vibrate) navigator.vibrate([300, 200, 300, 200, 300]);
  }
  function stopRinging(){
    if(ringInterval){ clearInterval(ringInterval); ringInterval = null; }
    if(navigator.vibrate) navigator.vibrate(0);
  }

  /* --------------------------- DOM shell --------------------------- */
  function ensureRoot(){
    if(root) return;
    root = document.createElement('div');
    root.id = 'cc-root';
    document.body.appendChild(root);

    fabBtn = el(`
      <button id="cc-fab" class="cc-fab" title="Start a call" aria-label="Start a call">
        <span class="cc-fab-icon" aria-hidden="true">\u{1F4DE}</span>
        <span id="cc-fab-badge" class="cc-fab-badge hidden" aria-hidden="true">0</span>
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
        <div class="cc-control-banner hidden" id="cc-control-banner"></div>
        <div class="cc-bubble-controls">
          <button class="cc-ctrl" id="cc-toggle-mic" title="Mute / unmute" aria-label="Mute or unmute microphone">\u{1F3A4}</button>
          <button class="cc-ctrl" id="cc-toggle-cam" title="Camera on / off" aria-label="Turn camera on or off">\u{1F4F9}</button>
          <button class="cc-ctrl" id="cc-toggle-share" title="Share your screen" aria-label="Share your screen">\u{1F5A5}\uFE0F</button>
          <button class="cc-ctrl" id="cc-request-control" title="Request control of their screen" aria-label="Request control of their screen">\u{1F5B1}\uFE0F</button>
          <button class="cc-ctrl cc-ctrl-expand" id="cc-expand" title="Enlarge" aria-label="Enlarge call window">\u26F6</button>
          <button class="cc-ctrl cc-ctrl-min" id="cc-minimize" title="Minimize" aria-label="Minimize call">\u2014</button>
          <button class="cc-ctrl cc-ctrl-end" id="cc-hangup" title="Hang up" aria-label="Hang up call">\u2715</button>
        </div>
      </div>`);
    root.appendChild(bubbleEl);
    localVideoEl = bubbleEl.querySelector('#cc-local-video');
    remoteVideoEl = bubbleEl.querySelector('#cc-remote-video');

    bubbleEl.querySelector('#cc-hangup').addEventListener('click', ()=> endCall('ended'));
    bubbleEl.querySelector('#cc-minimize').addEventListener('click', toggleMinimize);
    bubbleEl.querySelector('#cc-toggle-mic').addEventListener('click', toggleMic);
    bubbleEl.querySelector('#cc-toggle-cam').addEventListener('click', toggleCam);
    bubbleEl.querySelector('#cc-toggle-share').addEventListener('click', toggleScreenShare);
    bubbleEl.querySelector('#cc-request-control').addEventListener('click', requestControlOfThem);
    bubbleEl.querySelector('#cc-expand').addEventListener('click', toggleExpand);
    makeDraggable(bubbleEl);
    wireRemoteVideoInputCapture();

    controlRequestEl = el(`<div id="cc-control-request" class="cc-incoming hidden"></div>`);
    root.appendChild(controlRequestEl);
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
          const data = change.doc.data();
          if(change.type === 'removed' || (data && ['ended','missed','declined'].includes(data.status))){
            if(!incomingEl.classList.contains('hidden')){ stopRinging(); incomingEl.classList.add('hidden'); }
            return;
          }
          if(change.type !== 'added' && change.type !== 'modified') return;
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
    startRinging();
    incomingEl.innerHTML = `
      <div class="cc-incoming-card">
        <div class="cc-incoming-title">${esc(data.callerName || 'Someone')} is calling\u2026</div>
        <div class="cc-incoming-actions">
          <button class="btn primary" id="cc-accept" aria-label="Accept call from ${esc(data.callerName || 'caller')}">Accept</button>
          <button class="btn danger" id="cc-decline" aria-label="Decline call from ${esc(data.callerName || 'caller')}">Decline</button>
        </div>
      </div>`;
    incomingEl.classList.remove('hidden');
    incomingEl.querySelector('#cc-decline').onclick = ()=>{
      stopRinging();
      incomingEl.classList.add('hidden');
      callsCol().doc(callId).update({ status: 'declined' }).catch(()=>{});
    };
    incomingEl.querySelector('#cc-accept').onclick = async ()=>{
      stopRinging();
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
    cameraTrack = localStream.getVideoTracks()[0] || null;
    controlChannel = pc.createDataChannel('control');
    wireControlChannel(controlChannel);
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

    // The callee can start sending ICE candidates as soon as they answer —
    // which can arrive here before we've finished setRemoteDescription below.
    // Adding a candidate before that throws, so buffer anything that shows up
    // early and flush it once the remote description is actually set.
    let remoteDescSet = false;
    let pendingCandidates = [];
    unsubCallDoc = callDocRef.onSnapshot(async doc=>{
      const data = doc.data();
      if(!data) return;
      if(data.answer && pc && !pc.currentRemoteDescription){
        clearTimeout(ringTimer);
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        remoteDescSet = true;
        for(const c of pendingCandidates){ pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{}); }
        pendingCandidates = [];
        showBubble(`In call with ${target.name}`);
      }
      if(data.status === 'declined'){ endCall(null, `${target.name} declined the call.`); }
      if(data.status === 'ended'){ endCall(null); }
    });

    unsubTheirCandidates = callDocRef.collection('calleeCandidates').onSnapshot(snap=>{
      snap.docChanges().forEach(change=>{
        if(change.type !== 'added') return;
        const candidate = change.doc.data();
        if(remoteDescSet && pc) pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{});
        else pendingCandidates.push(candidate);
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
    cameraTrack = localStream.getVideoTracks()[0] || null;
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
    conn.ondatachannel = e=>{
      if(e.channel.label === 'control'){ controlChannel = e.channel; wireControlChannel(controlChannel); }
    };
    conn.ontrack = e=>{
      // Prefer the bundled stream when present, but some browsers (notably
      // older iOS Safari) don't populate e.streams — fall back to building
      // one from the track directly so video still shows up there.
      const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      if(remoteVideoEl.srcObject !== stream) remoteVideoEl.srcObject = stream;
      remoteVideoEl.play().catch(()=>{}); // autoplay can be blocked silently; retry after a user gesture already happened (Accept/Call tap)
    };
    conn.oniceconnectionstatechange = ()=>{
      // Visible, non-technical status so problems are diagnosable from a
      // phone with no access to devtools.
      const state = conn.iceConnectionState;
      if(state === 'checking') showStatus('Connecting…');
      else if(state === 'connected' || state === 'completed') reportConnectionType();
      else if(state === 'disconnected') showStatus('Connection interrupted — trying to reconnect…');
      else if(state === 'failed') showStatus("Couldn't connect — network may be blocking the call.");
    };
    conn.onconnectionstatechange = ()=>{
      if(conn.connectionState === 'failed' || conn.connectionState === 'closed'){
        clearTimeout(disconnectGraceTimer);
        endCall(null, conn.connectionState === 'failed'
          ? "Call couldn't connect — this often means the network is blocking video calls. Try a different wifi/network on one side."
          : null);
      }else if(conn.connectionState === 'disconnected'){
        // Networks blip — ICE often recovers on its own within a few seconds.
        // Give it a grace window before treating it as a real hang-up, and
        // cancel that timer if the state improves before it fires.
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = setTimeout(()=>{
          if(conn.connectionState === 'disconnected') endCall(null, 'Call dropped — the connection was lost.');
        }, 8000);
      }else if(conn.connectionState === 'connected'){
        clearTimeout(disconnectGraceTimer);
      }
    };
    return conn;
  }
  let disconnectGraceTimer = null;
  function showStatus(text){
    const el = bubbleEl && bubbleEl.querySelector('#cc-bubble-status');
    if(el) el.textContent = text;
  }
  // Once connected, check whether the media path is direct (host/srflx) or
  // relayed through TURN — shown in the bubble so a stuck "blank video" case
  // can be told apart from a real no-connection case.
  async function reportConnectionType(){
    if(!pc) return;
    try{
      const stats = await pc.getStats();
      let pairType = null;
      stats.forEach(r=>{
        if(r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated){
          const local = stats.get(r.localCandidateId);
          if(local) pairType = local.candidateType; // host | srflx | relay
        }
      });
      const label = pairType === 'relay' ? 'connected (relayed)' : pairType ? 'connected (direct)' : 'connected';
      showStatus(inCallWith ? `In call with ${inCallWith.name} — ${label}` : label);
    }catch(e){
      showStatus(inCallWith ? `In call with ${inCallWith.name}` : '');
    }
  }

  function endCall(setStatus, note){
    clearTimeout(ringTimer);
    clearTimeout(disconnectGraceTimer);
    if(setStatus && callDocRef) callDocRef.update({ status: setStatus }).catch(()=>{});
    else if(callDocRef) callDocRef.update({ status: 'ended' }).catch(()=>{});
    if(unsubCallDoc){ unsubCallDoc(); unsubCallDoc = null; }
    if(unsubTheirCandidates){ unsubTheirCandidates(); unsubTheirCandidates = null; }
    if(screenStream){ screenStream.getTracks().forEach(t=> t.stop()); screenStream = null; }
    if(controlChannel){ try{ controlChannel.close(); }catch(e){} controlChannel = null; }
    controlChannelOpen = false;
    iAmSharingAndGrantedControl = false;
    iAmControllingThem = false;
    isScreenSharing = false;
    cameraTrack = null;
    if(controlRequestEl) controlRequestEl.classList.add('hidden');
    if(pc){ pc.close(); pc = null; }
    if(localStream){ localStream.getTracks().forEach(t=> t.stop()); localStream = null; }
    if(localVideoEl) localVideoEl.srcObject = null;
    if(remoteVideoEl) remoteVideoEl.srcObject = null;
    callDocRef = null;
    inCallWith = null;
    callRoleInCall = null;
    isExpanded = false;
    if(bubbleEl) bubbleEl.classList.remove('cc-bubble-expanded');
    updateControlUI();
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
  function toggleMinimize(){
    if(isExpanded) toggleExpand();
    bubbleEl.classList.toggle('cc-bubble-min');
  }
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

  /* --------------------------- enlarge / expand --------------------------- */
  // Works the same way on phones, tablets, and desktops — it just docks the
  // bubble into a large centered panel instead of the small draggable one.
  function toggleExpand(){
    if(!bubbleEl) return;
    isExpanded = !isExpanded;
    bubbleEl.classList.toggle('cc-bubble-expanded', isExpanded);
    const btn = bubbleEl.querySelector('#cc-expand');
    if(btn){ btn.classList.toggle('cc-ctrl-active', isExpanded); btn.title = isExpanded ? 'Shrink' : 'Enlarge'; }
    if(isExpanded){ bubbleEl.style.left = ''; bubbleEl.style.top = ''; bubbleEl.style.right = ''; bubbleEl.style.bottom = ''; }
  }

  /* --------------------------- screen sharing --------------------------- */
  async function toggleScreenShare(){
    if(!pc || !localStream) return;
    if(isScreenSharing){ await stopScreenShare(); return; }
    if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
      alert("This browser doesn't support screen sharing.");
      return;
    }
    try{
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    }catch(e){
      return; // user cancelled the picker — nothing to do
    }
    const screenTrack = screenStream.getVideoTracks()[0];
    const sender = pc.getSenders().find(s=> s.track && s.track.kind === 'video');
    if(sender) await sender.replaceTrack(screenTrack);
    if(localVideoEl) localVideoEl.srcObject = screenStream;
    isScreenSharing = true;
    bubbleEl.querySelector('#cc-toggle-share').classList.add('cc-ctrl-active');
    // If the person stops sharing from the browser's own "Stop sharing" bar
    // instead of our button, catch that and revert automatically.
    screenTrack.onended = ()=> stopScreenShare();
    updateControlUI();
  }

  async function stopScreenShare(){
    if(screenStream){ screenStream.getTracks().forEach(t=> t.stop()); screenStream = null; }
    isScreenSharing = false;
    iAmSharingAndGrantedControl = false;
    if(pc && cameraTrack){
      const sender = pc.getSenders().find(s=> s.track && s.track.kind === 'video');
      if(sender) await sender.replaceTrack(cameraTrack).catch(()=>{});
    }
    if(localVideoEl) localVideoEl.srcObject = localStream;
    if(bubbleEl){
      bubbleEl.querySelector('#cc-toggle-share').classList.remove('cc-ctrl-active');
    }
    sendControlMessage({ type: 'sharing-stopped' });
    updateControlUI();
  }

  /* --------------------------- remote control --------------------------- */
  function wireControlChannel(channel){
    channel.onopen = ()=>{ controlChannelOpen = true; updateControlUI(); };
    channel.onclose = ()=>{ controlChannelOpen = false; iAmControllingThem = false; iAmSharingAndGrantedControl = false; updateControlUI(); };
    channel.onmessage = e=>{
      let msg; try{ msg = JSON.parse(e.data); }catch(err){ return; }
      handleControlMessage(msg);
    };
  }

  function sendControlMessage(msg){
    if(controlChannel && controlChannel.readyState === 'open') controlChannel.send(JSON.stringify(msg));
  }

  function requestControlOfThem(){
    if(!controlChannelOpen){ alert("Not connected yet — try again in a moment."); return; }
    sendControlMessage({ type: 'request-control', fromName: ctx.myName });
    showStatus('Requested control — waiting for them to accept…');
  }

  function handleControlMessage(msg){
    if(!msg || !msg.type) return;
    switch(msg.type){
      case 'request-control':
        showControlRequestPrompt(msg.fromName || 'The other person');
        break;
      case 'grant-control':
        iAmControllingThem = true;
        updateControlUI();
        showStatus(`You're controlling ${inCallWith ? inCallWith.name : 'their'} screen`);
        break;
      case 'deny-control':
        alert(`${inCallWith ? inCallWith.name : 'They'} declined to share control.`);
        break;
      case 'revoke-control':
      case 'sharing-stopped':
        iAmControllingThem = false;
        updateControlUI();
        break;
      case 'input':
        if(iAmSharingAndGrantedControl) applyIncomingInput(msg);
        break;
    }
  }

  function showControlRequestPrompt(fromName){
    if(!controlRequestEl) return;
    controlRequestEl.innerHTML = `
      <div class="cc-incoming-card">
        <div class="cc-incoming-title">${esc(fromName)} wants control of your screen\u2026</div>
        <div class="cc-incoming-actions">
          <button class="btn primary" id="cc-allow-control">Allow</button>
          <button class="btn danger" id="cc-deny-control">Deny</button>
        </div>
      </div>`;
    controlRequestEl.classList.remove('hidden');
    controlRequestEl.querySelector('#cc-allow-control').onclick = ()=>{
      controlRequestEl.classList.add('hidden');
      iAmSharingAndGrantedControl = true;
      updateControlUI();
      sendControlMessage({ type: 'grant-control' });
    };
    controlRequestEl.querySelector('#cc-deny-control').onclick = ()=>{
      controlRequestEl.classList.add('hidden');
      sendControlMessage({ type: 'deny-control' });
    };
  }

  function updateControlUI(){
    const banner = bubbleEl && bubbleEl.querySelector('#cc-control-banner');
    if(!banner) return;
    if(iAmSharingAndGrantedControl){
      banner.textContent = `${inCallWith ? inCallWith.name : 'They'} can click and type on your shared screen`;
      banner.classList.remove('hidden');
    }else if(iAmControllingThem){
      banner.textContent = `You're controlling their screen — click/type on the video`;
      banner.classList.remove('hidden');
    }else{
      banner.classList.add('hidden');
    }
    const reqBtn = bubbleEl && bubbleEl.querySelector('#cc-request-control');
    if(reqBtn) reqBtn.classList.toggle('cc-ctrl-active', iAmControllingThem);
  }

  // Captures clicks/keystrokes made on the remote video element (while I've
  // been granted control) and relays them, normalized 0–1 so they map onto
  // the sharer's own viewport regardless of window size.
  function wireRemoteVideoInputCapture(){
    remoteVideoEl.addEventListener('click', e=>{
      if(!iAmControllingThem) return;
      const rect = remoteVideoEl.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      sendControlMessage({ type: 'input', kind: 'click', nx, ny });
    });
    remoteVideoEl.tabIndex = 0; // so it can receive keyboard focus/events
    remoteVideoEl.addEventListener('keydown', e=>{
      if(!iAmControllingThem) return;
      sendControlMessage({ type: 'input', kind: 'keydown', key: e.key });
      e.preventDefault();
    });
  }

  function applyIncomingInput(msg){
    if(msg.kind === 'click' && typeof msg.nx === 'number'){
      const x = msg.nx * window.innerWidth;
      const y = msg.ny * window.innerHeight;
      const target = document.elementFromPoint(x, y);
      if(target){
        target.focus && target.focus();
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, clientX:x, clientY:y }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, clientX:x, clientY:y }));
        target.dispatchEvent(new MouseEvent('click', { bubbles:true, clientX:x, clientY:y }));
      }
    }else if(msg.kind === 'keydown' && msg.key){
      const target = document.activeElement;
      if(target){
        if((target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && msg.key.length === 1){
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? target.value.length;
          target.value = target.value.slice(0, start) + msg.key + target.value.slice(end);
          target.selectionStart = target.selectionEnd = start + 1;
          target.dispatchEvent(new Event('input', { bubbles:true }));
        }else if((target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && msg.key === 'Backspace'){
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? target.value.length;
          if(start === end && start > 0){
            target.value = target.value.slice(0, start-1) + target.value.slice(end);
            target.selectionStart = target.selectionEnd = start - 1;
          }else{
            target.value = target.value.slice(0, start) + target.value.slice(end);
            target.selectionStart = target.selectionEnd = start;
          }
          target.dispatchEvent(new Event('input', { bubbles:true }));
        }
        target.dispatchEvent(new KeyboardEvent('keydown', { key: msg.key, bubbles:true }));
      }
    }
  }

  function makeDraggable(node){
    node.addEventListener('pointerdown', e=>{
      if(e.target.closest('.cc-ctrl')) return; // don't drag when tapping a control
      if(isExpanded) return; // expanded view is docked, not draggable
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

  // Start a call directly by id/name — used by any UI that already knows who
  // to call (e.g. a teacher's "Video call" button next to a specific student
  // in the Students tab), bypassing the "call someone" panel/picker.
  function callPerson(id, name){
    if(!ctx){ return; }
    if(inCallWith || callDocRef){ alert('You are already in a call — end it before starting another.'); return; }
    startCall({ id, name });
  }

  function teardown(){
    stopRinging();
    if(unsubPresence){ unsubPresence(); unsubPresence = null; }
    if(unsubIncoming){ unsubIncoming(); unsubIncoming = null; }
    if(callDocRef || pc) endCall('ended');
    others = [];
    if(fabBtn) fabBtn.classList.add('hidden');
    if(panelEl) panelEl.classList.add('hidden');
    if(incomingEl) incomingEl.classList.add('hidden');
    ctx = null;
  }

  window.ClassroomCall = { init, teardown, callPerson };
})();