/* =========================================================================
   CLASSROOM WHITEBOARD — shared drawing module, used by teacher.html and
   student.html (and by call.js for the in-call overlay).

   Data model (Firestore):
     classes/{classId}/whiteboards/{boardId}                — metadata doc
       { title, createdBy, createdByName, createdAt, updatedAt }
     classes/{classId}/whiteboards/{boardId}/strokes/{id}    — one per pen stroke
       { color, size, tool, points:[{x,y},...], createdBy, createdByName,
         createdAt, done }

   Strokes are drawn locally the instant you draw them (zero delay for you),
   and flushed to Firestore in small batches (~8x/second) while you draw, so
   everyone else sees your line grow in near real time instead of waiting
   for the whole stroke to finish. All strokes persist, so every board is
   automatically there for review later — nothing needs to be "saved."

   Public API (attached to window.Whiteboard):
     init({ classId, myId, myName, myRole })
     teardown()
     mountPage(container)                 — full list + editor UI, for the
                                             "Whiteboard" nav tab
     openOverlay(boardKey, label)         — floating large editor used
                                             during a video call
     closeOverlay()
   ========================================================================= */
(function(){
  const FLUSH_MS = 120;             // how often in-progress points get pushed to Firestore
  const CANVAS_W = 1600, CANVAS_H = 900; // fixed logical drawing surface (16:9)
  const COLORS = ['#1F3A2E', '#C1502E', '#2B6CB0', '#B87A1F', '#6B3FA0', '#FFFFFF'];
  const SIZES = [{ label: 'S', px: 3 }, { label: 'M', px: 7 }, { label: 'L', px: 14 }];

  let ctx = null; // { classId, myId, myName, myRole }

  function el(html){ const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(str){ const d = document.createElement('div'); d.textContent = str ?? ''; return d.innerHTML; }
  function tsVal(ts){ return ts && ts.toMillis ? ts.toMillis() : (ts || 0); }
  function timeAgo(ts){
    if(!ts) return 'just now';
    const mins = Math.floor((Date.now()-ts)/60000);
    if(mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`;
    const hrs = Math.floor(mins/60);
    if(hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs/24)}d ago`;
  }
  function boardsCol(){ return db.collection('classes').doc(ctx.classId).collection('whiteboards'); }
  function strokesCol(boardId){ return boardsCol().doc(boardId).collection('strokes'); }

  /* --------------------------- board list (review) --------------------------- */
  function mountPage(container){
    let unsubList = null;
    let boards = [];

    function renderList(){
      let html = `<div class="wb-list-head">
        <h3>Whiteboards</h3>
        <button class="btn primary small" id="wb-new">New whiteboard</button>
      </div>`;
      if(boards.length === 0){
        html += `<div class="empty"><h3>No whiteboards yet</h3><p>Start one — everyone in the class can draw on it together, and it stays saved for review.</p></div>`;
      }else{
        html += `<div class="wb-grid">`;
        boards.forEach(b=>{
          html += `<div class="wb-card" data-open="${b.id}">
            <div class="wb-card-thumb">\u{1F58A}\uFE0F</div>
            <div class="wb-card-title">${esc(b.title || 'Untitled board')}</div>
            <div class="wb-card-meta">Updated ${timeAgo(tsVal(b.updatedAt))} \u00B7 by ${esc(b.createdByName || '—')}</div>
            <button class="btn small danger wb-card-delete" data-delete="${b.id}" aria-label="Delete board">Delete</button>
          </div>`;
        });
        html += `</div>`;
      }
      container.innerHTML = `<div class="wb-page">${html}</div>`;
      const newBtn = container.querySelector('#wb-new');
      if(newBtn) newBtn.onclick = createBoardAndOpen;
      container.querySelectorAll('[data-open]').forEach(card=>{
        card.addEventListener('click', (e)=>{
          if(e.target.closest('[data-delete]')) return;
          openEditorInPage(card.dataset.open);
        });
      });
      container.querySelectorAll('[data-delete]').forEach(btn=>{
        btn.addEventListener('click', async (e)=>{
          e.stopPropagation();
          if(!confirm('Delete this whiteboard for everyone? This can\'t be undone.')) return;
          await deleteBoard(btn.dataset.delete);
        });
      });
    }

    async function createBoardAndOpen(){
      const title = prompt('Name this whiteboard:', `Board — ${new Date().toLocaleDateString()}`);
      if(title === null) return;
      const ref = await boardsCol().add({
        title: title.trim() || 'Untitled board',
        createdBy: ctx.myId, createdByName: ctx.myName,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      openEditorInPage(ref.id);
    }

    function openEditorInPage(boardId){
      if(unsubList){ unsubList(); unsubList = null; }
      const board = boards.find(b=> b.id === boardId);
      buildEditor(container, boardId, {
        title: board ? board.title : 'Whiteboard',
        onClose: ()=>{ watchList(); }
      });
    }

    function watchList(){
      unsubList = boardsCol().orderBy('updatedAt', 'desc').onSnapshot(snap=>{
        boards = snap.docs.map(d=>({ id: d.id, ...d.data() }));
        renderList();
      }, ()=>{ container.innerHTML = `<div class="empty"><h3>Couldn't load whiteboards</h3><p>Check your connection and try again.</p></div>`; });
    }

    // Expose a teardown hook so callers switching views away can stop the listener.
    container._wbTeardown = ()=>{ if(unsubList) unsubList(); teardownEditor(); };
    watchList();
  }

  async function deleteBoard(boardId){
    const snap = await strokesCol(boardId).get();
    const chunks = [];
    for(let i=0;i<snap.docs.length;i+=400) chunks.push(snap.docs.slice(i,i+400));
    for(const chunk of chunks){
      const batch = db.batch();
      chunk.forEach(d=> batch.delete(d.ref));
      await batch.commit().catch(()=>{});
    }
    await boardsCol().doc(boardId).delete().catch(()=>{});
  }

  /* --------------------------- shared editor (list mode + overlay mode) --------------------------- */
  let activeBoardId = null;
  let unsubStrokes = null;
  let strokeCache = {};      // id -> stroke data, as synced from Firestore
  let bgCanvas = null, bgCtx = null;
  let liveCanvas = null, liveCtx = null;
  let currentStrokeId = null;
  let currentStrokePoints = [];
  let pendingFlush = [];
  let flushTimer = null;
  let currentColor = COLORS[0];
  let currentSize = SIZES[1].px;
  let currentTool = 'pen'; // 'pen' | 'eraser'

  function buildEditor(container, boardId, opts){
    teardownEditor();
    activeBoardId = boardId;
    const colorSwatches = COLORS.map(c=> `<button class="wb-swatch" data-color="${c}" style="background:${c};${c==='#FFFFFF'?'border-color:var(--line);':''}" aria-label="Color ${c}"></button>`).join('');
    const sizeButtons = SIZES.map(s=> `<button class="wb-size-btn" data-size="${s.px}">${s.label}</button>`).join('');
    container.innerHTML = `
      <div class="wb-editor">
        <div class="wb-toolbar">
          ${opts.onClose ? `<button class="btn small" id="wb-back">\u2190 All boards</button>` : ''}
          <div class="wb-title" id="wb-title" title="Click to rename">${esc(opts.title || 'Whiteboard')}</div>
          <div class="wb-tools">
            <div class="wb-swatches">${colorSwatches}</div>
            <div class="wb-sizes">${sizeButtons}</div>
            <button class="btn small" id="wb-eraser">\u{1F9FD} Eraser</button>
            <button class="btn small danger" id="wb-clear">Clear</button>
            ${opts.onCloseOverlay ? `<button class="btn small" id="wb-overlay-close">Close</button>` : ''}
          </div>
        </div>
        <div class="wb-canvas-wrap">
          <canvas id="wb-bg" class="wb-canvas"></canvas>
          <canvas id="wb-live" class="wb-canvas wb-canvas-live"></canvas>
        </div>
      </div>`;

    bgCanvas = container.querySelector('#wb-bg');
    liveCanvas = container.querySelector('#wb-live');
    bgCanvas.width = CANVAS_W; bgCanvas.height = CANVAS_H;
    liveCanvas.width = CANVAS_W; liveCanvas.height = CANVAS_H;
    bgCtx = bgCanvas.getContext('2d');
    liveCtx = liveCanvas.getContext('2d');
    bgCtx.fillStyle = '#FFFFFF'; bgCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    container.querySelectorAll('[data-color]').forEach(b=>{
      b.classList.toggle('wb-swatch-active', b.dataset.color === currentColor);
      b.onclick = ()=>{ currentColor = b.dataset.color; currentTool = 'pen'; syncToolButtons(container); };
    });
    container.querySelectorAll('[data-size]').forEach(b=>{
      b.classList.toggle('wb-size-active', Number(b.dataset.size) === currentSize);
      b.onclick = ()=>{ currentSize = Number(b.dataset.size); syncToolButtons(container); };
    });
    const eraserBtn = container.querySelector('#wb-eraser');
    eraserBtn.onclick = ()=>{ currentTool = currentTool === 'eraser' ? 'pen' : 'eraser'; syncToolButtons(container); };
    syncToolButtons(container);

    container.querySelector('#wb-clear').onclick = async ()=>{
      if(!confirm('Clear this whole board for everyone?')) return;
      strokeCache = {};
      redraw();
      await deleteAllStrokes(boardId);
      boardsCol().doc(boardId).update({ updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
    };

    const titleEl = container.querySelector('#wb-title');
    if(titleEl){
      titleEl.onclick = async ()=>{
        const next = prompt('Rename whiteboard:', titleEl.textContent);
        if(next === null || !next.trim()) return;
        titleEl.textContent = next.trim();
        await boardsCol().doc(boardId).update({ title: next.trim() }).catch(()=>{});
      };
    }
    const backBtn = container.querySelector('#wb-back');
    if(backBtn) backBtn.onclick = ()=>{ teardownEditor(); if(opts.onClose) opts.onClose(); };
    const overlayCloseBtn = container.querySelector('#wb-overlay-close');
    if(overlayCloseBtn) overlayCloseBtn.onclick = ()=>{ if(opts.onCloseOverlay) opts.onCloseOverlay(); };

    wirePointerEvents(liveCanvas);
    watchStrokes(boardId);
  }

  function syncToolButtons(container){
    container.querySelectorAll('[data-color]').forEach(b=> b.classList.toggle('wb-swatch-active', b.dataset.color === currentColor && currentTool !== 'eraser'));
    container.querySelectorAll('[data-size]').forEach(b=> b.classList.toggle('wb-size-active', Number(b.dataset.size) === currentSize));
    const eraserBtn = container.querySelector('#wb-eraser');
    if(eraserBtn) eraserBtn.classList.toggle('cc-ctrl-active', currentTool === 'eraser');
  }

  function watchStrokes(boardId){
    strokeCache = {};
    unsubStrokes = strokesCol(boardId).orderBy('createdAt').onSnapshot(snap=>{
      snap.docChanges().forEach(change=>{
        if(change.type === 'removed'){ delete strokeCache[change.doc.id]; return; }
        strokeCache[change.doc.id] = { id: change.doc.id, ...change.doc.data() };
      });
      redraw();
    }, ()=>{});
  }

  async function deleteAllStrokes(boardId){
    const snap = await strokesCol(boardId).get();
    const chunks = [];
    for(let i=0;i<snap.docs.length;i+=400) chunks.push(snap.docs.slice(i,i+400));
    for(const chunk of chunks){
      const batch = db.batch();
      chunk.forEach(d=> batch.delete(d.ref));
      await batch.commit().catch(()=>{});
    }
  }

  function redraw(){
    if(!bgCtx) return;
    bgCtx.fillStyle = '#FFFFFF';
    bgCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    Object.values(strokeCache)
      .sort((a,b)=> tsVal(a.createdAt) - tsVal(b.createdAt))
      .forEach(s=> drawStroke(bgCtx, s.points || [], s.color, s.size, s.tool));
  }

  function drawStroke(targetCtx, points, color, size, tool){
    if(!points || points.length < 2){
      if(points && points.length === 1) drawDot(targetCtx, points[0], color, size, tool);
      return;
    }
    targetCtx.save();
    targetCtx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    targetCtx.strokeStyle = tool === 'eraser' ? 'rgba(0,0,0,1)' : (color || '#1F3A2E');
    targetCtx.lineWidth = size || 5;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    targetCtx.beginPath();
    targetCtx.moveTo(points[0].x, points[0].y);
    for(let i=1;i<points.length;i++) targetCtx.lineTo(points[i].x, points[i].y);
    targetCtx.stroke();
    targetCtx.restore();
  }
  function drawDot(targetCtx, p, color, size, tool){
    targetCtx.save();
    targetCtx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    targetCtx.fillStyle = tool === 'eraser' ? 'rgba(0,0,0,1)' : (color || '#1F3A2E');
    targetCtx.beginPath();
    targetCtx.arc(p.x, p.y, (size || 5)/2, 0, Math.PI*2);
    targetCtx.fill();
    targetCtx.restore();
  }

  /* --------------------------- pointer input --------------------------- */
  function canvasPoint(e){
    const rect = liveCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * CANVAS_W;
    const y = (e.clientY - rect.top) / rect.height * CANVAS_H;
    return { x: Math.max(0, Math.min(CANVAS_W, x)), y: Math.max(0, Math.min(CANVAS_H, y)) };
  }

  function wirePointerEvents(canvas){
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e=>{
      canvas.setPointerCapture(e.pointerId);
      startStroke(canvasPoint(e));
    });
    canvas.addEventListener('pointermove', e=>{
      if(!currentStrokeId) return;
      extendStroke(canvasPoint(e));
    });
    ['pointerup','pointercancel','pointerleave'].forEach(evt=>{
      canvas.addEventListener(evt, ()=>{ if(currentStrokeId) endStroke(); });
    });
  }

  function startStroke(pt){
    currentStrokeId = `${ctx.myId}-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    currentStrokePoints = [pt];
    pendingFlush = [pt];
    liveCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    drawDot(liveCtx, pt, currentColor, currentSize, currentTool);
    strokesCol(activeBoardId).doc(currentStrokeId).set({
      color: currentColor, size: currentSize, tool: currentTool,
      points: [pt], createdBy: ctx.myId, createdByName: ctx.myName,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(), done: false
    }).catch(()=>{});
    flushTimer = setInterval(flushPending, FLUSH_MS);
  }

  function extendStroke(pt){
    const last = currentStrokePoints[currentStrokePoints.length - 1];
    currentStrokePoints.push(pt);
    pendingFlush.push(pt);
    liveCtx.save();
    liveCtx.globalCompositeOperation = currentTool === 'eraser' ? 'destination-out' : 'source-over';
    liveCtx.strokeStyle = currentColor;
    liveCtx.lineWidth = currentSize;
    liveCtx.lineCap = 'round';
    liveCtx.beginPath();
    liveCtx.moveTo(last.x, last.y);
    liveCtx.lineTo(pt.x, pt.y);
    liveCtx.stroke();
    liveCtx.restore();
  }

  function flushPending(){
    if(!activeBoardId || !currentStrokeId || pendingFlush.length === 0) return;
    const pts = pendingFlush; pendingFlush = [];
    strokesCol(activeBoardId).doc(currentStrokeId).update({
      points: firebase.firestore.FieldValue.arrayUnion(...pts)
    }).catch(()=>{});
  }

  function endStroke(){
    clearInterval(flushTimer); flushTimer = null;
    flushPending();
    if(activeBoardId && currentStrokeId){
      strokesCol(activeBoardId).doc(currentStrokeId).update({ done: true }).catch(()=>{});
      boardsCol().doc(activeBoardId).update({ updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
    }
    // Fold the just-finished stroke into the local cache immediately so
    // there's no visible gap while we wait for our own snapshot echo back.
    if(currentStrokeId){
      strokeCache[currentStrokeId] = {
        id: currentStrokeId, color: currentColor, size: currentSize, tool: currentTool,
        points: currentStrokePoints, createdAt: { toMillis: ()=> Date.now() }
      };
      redraw();
    }
    liveCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    currentStrokeId = null;
    currentStrokePoints = [];
    pendingFlush = [];
  }

  function teardownEditor(){
    if(unsubStrokes){ unsubStrokes(); unsubStrokes = null; }
    if(flushTimer){ clearInterval(flushTimer); flushTimer = null; }
    activeBoardId = null;
    strokeCache = {};
    currentStrokeId = null;
    bgCanvas = liveCanvas = bgCtx = liveCtx = null;
  }

  /* --------------------------- in-call overlay --------------------------- */
  let overlayRoot = null;

  function openOverlay(boardKey, label){
    if(!ctx) return;
    closeOverlay();
    overlayRoot = el(`<div id="wb-overlay-root" class="wb-overlay-bg">
      <div class="wb-overlay-panel"></div>
    </div>`);
    document.body.appendChild(overlayRoot);
    overlayRoot.addEventListener('click', e=>{ if(e.target === overlayRoot) closeOverlay(); });
    const panel = overlayRoot.querySelector('.wb-overlay-panel');

    ensureCallBoard(boardKey, label).then(boardId=>{
      buildEditor(panel, boardId, {
        title: label ? `Whiteboard \u2014 ${label}` : 'Call whiteboard',
        onCloseOverlay: closeOverlay
      });
    });
  }

  async function ensureCallBoard(boardKey, label){
    const boardId = `call-${boardKey}`;
    const ref = boardsCol().doc(boardId);
    const doc = await ref.get();
    if(!doc.exists){
      await ref.set({
        title: `Whiteboard \u2014 ${label || 'call'} \u2014 ${new Date().toLocaleDateString()}`,
        createdBy: ctx.myId, createdByName: ctx.myName,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    return boardId;
  }

  function closeOverlay(){
    teardownEditor();
    if(overlayRoot){ overlayRoot.remove(); overlayRoot = null; }
  }

  /* --------------------------- public API --------------------------- */
  function init(newCtx){ ctx = newCtx; }
  function teardown(){ closeOverlay(); teardownEditor(); ctx = null; }

  window.Whiteboard = { init, teardown, mountPage, openOverlay, closeOverlay };
})();
