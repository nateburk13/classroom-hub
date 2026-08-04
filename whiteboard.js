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
  // Shapes dropdown — click a shape, then drag on the board to draw it.
  const SHAPE_DEFS = [
    { tool: 'line',     label: 'Line',      icon: '\u2571' },
    { tool: 'arrow',    label: 'Arrow',     icon: '\u2192' },
    { tool: 'rect',     label: 'Rectangle', icon: '\u25AD' },
    { tool: 'circle',   label: 'Circle',    icon: '\u25EF' },
    { tool: 'triangle', label: 'Triangle',  icon: '\u25B3' }
  ];
  const SHAPE_TOOLS = SHAPE_DEFS.map(s=> s.tool);
  // Text dropdown — font choices are limited to fonts this app already
  // loads via Google Fonts (see teacher.html / student.html <head>).
  const FONT_FAMILIES = [
    { label: 'Sans',  value: "'Inter', sans-serif" },
    { label: 'Serif', value: "'Roboto Slab', serif" },
    { label: 'Mono',  value: "'JetBrains Mono', monospace" }
  ];
  const FONT_SIZES = [16, 20, 24, 32, 40, 56, 72];
  // Symbols dropdown — click one, then click the board to stamp it (stays
  // selected so you can stamp several in a row).
  const SYMBOL_GROUPS = [
    { label: 'Marks',  items: ['\u2605','\u2606','\u2764','\u2713','\u2717','\u2757','\u2753','\u203C'] },
    { label: 'Arrows', items: ['\u2191','\u2193','\u2190','\u2192','\u2196','\u2197','\u2198','\u2199'] },
    { label: 'Shapes', items: ['\u25CF','\u25CB','\u25A0','\u25A1','\u25B2','\u25B3','\u25C6','\u25C7'] },
    { label: 'Math',   items: ['+','\u2212','\u00D7','\u00F7','=','\u2260','%','\u00B0'] },
    { label: 'Misc',   items: ['\u2600','\u2601','\u2602','\u2603','\u26A1','\u2699','\u266A','\u263A'] }
  ];

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
  function cursorsCol(boardId){ return boardsCol().doc(boardId).collection('cursors'); }
  function colorForUser(userId){
    let hash = 0;
    for(let i=0;i<userId.length;i++) hash = (hash*31 + userId.charCodeAt(i)) >>> 0;
    return CURSOR_COLORS[hash % CURSOR_COLORS.length];
  }

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
  let currentTool = 'pen'; // 'pen' | 'eraser' | 'text' | 'symbol' | shape tool name
  let currentSymbol = SYMBOL_GROUPS[0].items[0];
  let currentFontFamily = FONT_FAMILIES[0].value;
  let currentFontSize = 32;
  let currentBold = false;
  let currentItalic = false;
  let shapeStartPt = null;   // start point while dragging out a shape
  let myStrokeStack = [];   // ids of strokes *I* drew on the current board, in order — powers Undo
  let undoBtn = null;
  let keydownHandler = null;
  let symbolPanelOutsideHandler = null;

  // ------- live cursor presence -------
  const CURSOR_COLORS = ['#C1502E', '#2B6CB0', '#B87A1F', '#6B3FA0', '#3B6D40', '#B8336A'];
  const CURSOR_WRITE_MS = 70;    // how often we broadcast our own pointer position
  const CURSOR_STALE_MS = 8000;  // hide a cursor if its owner stopped updating it (closed tab, etc.)
  let unsubCursors = null;
  let cursorCache = {};          // userId -> { name, x, y, color, updatedAt }
  let cursorEls = {};            // userId -> DOM node
  let cursorLayerEl = null;
  let lastCursorWrite = 0;
  let cursorSweepTimer = null;

  function buildEditor(container, boardId, opts){
    teardownEditor();
    activeBoardId = boardId;
    const colorSwatches = COLORS.map(c=> `<button class="wb-swatch" data-color="${c}" style="background:${c};${c==='#FFFFFF'?'border-color:var(--line);':''}" aria-label="Color ${c}"></button>`).join('');
    const sizeButtons = SIZES.map(s=> `<button class="wb-size-btn" data-size="${s.px}">${s.label}</button>`).join('');
    const shapeItems = SHAPE_DEFS.map(s=> `<button class="wb-dropdown-item" data-tool="${s.tool}" title="${esc(s.label)}"><span class="wb-dropdown-item-icon">${s.icon}</span><span>${esc(s.label)}</span></button>`).join('');
    const fontOptions = FONT_FAMILIES.map(f=> `<option value="${esc(f.value)}">${esc(f.label)}</option>`).join('');
    const sizeOptions = FONT_SIZES.map(sz=> `<option value="${sz}">${sz}px</option>`).join('');
    const symbolGroups = SYMBOL_GROUPS.map(g=> `<div class="wb-symbol-group-label">${esc(g.label)}</div><div class="wb-symbol-grid">${g.items.map(s=> `<button class="wb-symbol-btn" data-symbol="${s}">${s}</button>`).join('')}</div>`).join('');
    container.innerHTML = `
      <div class="wb-editor">
        <div class="wb-toolbar">
          ${opts.onClose ? `<button class="btn small" id="wb-back">\u2190 All boards</button>` : ''}
          <div class="wb-title" id="wb-title" title="Click to rename">${esc(opts.title || 'Whiteboard')}</div>
          <div class="wb-tools">
            <div class="wb-swatches">${colorSwatches}</div>
            <div class="wb-sizes">${sizeButtons}</div>
            <button class="btn small" id="wb-eraser" data-tool="eraser">\u{1F9FD} Eraser</button>

            <div class="wb-dropdown-wrap">
              <button class="btn small wb-dropdown-toggle" id="wb-shapes-toggle" title="Insert a shape">\u25AD Shapes \u25BE</button>
              <div class="wb-dropdown-panel hidden" id="wb-shapes-panel">${shapeItems}</div>
            </div>

            <div class="wb-dropdown-wrap">
              <button class="btn small wb-dropdown-toggle" id="wb-text-toggle" title="Add text">\u{1F524} Text \u25BE</button>
              <div class="wb-dropdown-panel wb-text-panel hidden" id="wb-text-panel">
                <label>Font</label>
                <select id="wb-font-family">${fontOptions}</select>
                <label>Size</label>
                <select id="wb-font-size">${sizeOptions}</select>
                <div class="wb-text-style-row">
                  <button class="btn small" id="wb-bold-toggle" title="Bold"><b>B</b></button>
                  <button class="btn small" id="wb-italic-toggle" title="Italic"><i>I</i></button>
                </div>
                <p class="wb-dropdown-hint">Click the board to place text.</p>
              </div>
            </div>

            <div class="wb-dropdown-wrap">
              <button class="btn small wb-dropdown-toggle" id="wb-symbols-toggle" title="Insert a symbol">\u2733 Symbols \u25BE</button>
              <div class="wb-dropdown-panel wb-symbol-panel hidden" id="wb-symbol-panel">${symbolGroups}</div>
            </div>

            <button class="btn small" id="wb-undo" title="Undo your last stroke (Ctrl/Cmd+Z)">\u21B6 Undo</button>
            <button class="btn small" id="wb-export" title="Download this board as an image">\u2B07 PNG</button>
            <button class="btn small danger" id="wb-clear">Clear</button>
            ${opts.onCloseOverlay ? `<button class="btn small" id="wb-overlay-close">Close</button>` : ''}
          </div>
        </div>
        <div class="wb-canvas-wrap">
          <canvas id="wb-bg" class="wb-canvas"></canvas>
          <canvas id="wb-live" class="wb-canvas wb-canvas-live"></canvas>
          <div id="wb-cursor-layer" class="wb-cursor-layer"></div>
        </div>
      </div>`;

    bgCanvas = container.querySelector('#wb-bg');
    liveCanvas = container.querySelector('#wb-live');
    bgCanvas.width = CANVAS_W; bgCanvas.height = CANVAS_H;
    liveCanvas.width = CANVAS_W; liveCanvas.height = CANVAS_H;
    bgCtx = bgCanvas.getContext('2d');
    liveCtx = liveCanvas.getContext('2d');
    bgCtx.fillStyle = '#FFFFFF'; bgCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    cursorLayerEl = container.querySelector('#wb-cursor-layer');

    container.querySelectorAll('[data-color]').forEach(b=>{
      b.classList.toggle('wb-swatch-active', b.dataset.color === currentColor);
      b.onclick = ()=>{ currentColor = b.dataset.color; currentTool = 'pen'; syncToolButtons(container); };
    });
    container.querySelectorAll('[data-size]').forEach(b=>{
      b.classList.toggle('wb-size-active', Number(b.dataset.size) === currentSize);
      b.onclick = ()=>{ currentSize = Number(b.dataset.size); syncToolButtons(container); };
    });
    container.querySelectorAll('[data-tool]').forEach(b=>{
      b.onclick = ()=>{
        const tool = b.dataset.tool;
        currentTool = currentTool === tool ? 'pen' : tool;
        shapeStartPt = null;
        if(liveCtx) liveCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        closeAllDropdowns(container);
        syncToolButtons(container);
      };
    });

    // ---- Shapes dropdown: just opens/closes; picking an item (above) sets the tool ----
    const shapesToggle = container.querySelector('#wb-shapes-toggle');
    const shapesPanel = container.querySelector('#wb-shapes-panel');
    if(shapesToggle && shapesPanel){
      shapesToggle.onclick = (e)=>{ e.stopPropagation(); const willOpen = shapesPanel.classList.contains('hidden'); closeAllDropdowns(container); if(willOpen) shapesPanel.classList.remove('hidden'); };
    }

    // ---- Text dropdown: the toggle both selects the text tool AND opens
    // the panel so font/size/bold/italic can be adjusted before placing. ----
    const textToggle = container.querySelector('#wb-text-toggle');
    const textPanel = container.querySelector('#wb-text-panel');
    if(textToggle && textPanel){
      textToggle.onclick = (e)=>{
        e.stopPropagation();
        const willOpen = textPanel.classList.contains('hidden');
        currentTool = 'text';
        shapeStartPt = null;
        if(liveCtx) liveCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        closeAllDropdowns(container);
        if(willOpen) textPanel.classList.remove('hidden');
        syncToolButtons(container);
      };
      const fontSelect = container.querySelector('#wb-font-family');
      const sizeSelect = container.querySelector('#wb-font-size');
      const boldBtn = container.querySelector('#wb-bold-toggle');
      const italicBtn = container.querySelector('#wb-italic-toggle');
      fontSelect.value = currentFontFamily;
      sizeSelect.value = String(currentFontSize);
      boldBtn.classList.toggle('cc-ctrl-active', currentBold);
      italicBtn.classList.toggle('cc-ctrl-active', currentItalic);
      fontSelect.onchange = ()=>{ currentFontFamily = fontSelect.value; };
      sizeSelect.onchange = ()=>{ currentFontSize = Number(sizeSelect.value); };
      boldBtn.onclick = (e)=>{ e.stopPropagation(); currentBold = !currentBold; boldBtn.classList.toggle('cc-ctrl-active', currentBold); };
      italicBtn.onclick = (e)=>{ e.stopPropagation(); currentItalic = !currentItalic; italicBtn.classList.toggle('cc-ctrl-active', currentItalic); };
      textPanel.onclick = (e)=> e.stopPropagation(); // keep panel open while adjusting controls
    }

    // ---- Symbols dropdown ----
    const symbolToggle = container.querySelector('#wb-symbols-toggle');
    const symbolPanel = container.querySelector('#wb-symbol-panel');
    if(symbolToggle && symbolPanel){
      symbolToggle.onclick = (e)=>{ e.stopPropagation(); const willOpen = symbolPanel.classList.contains('hidden'); closeAllDropdowns(container); if(willOpen) symbolPanel.classList.remove('hidden'); };
      symbolPanel.querySelectorAll('[data-symbol]').forEach(b=>{
        b.onclick = ()=>{
          currentSymbol = b.dataset.symbol;
          currentTool = 'symbol';
          shapeStartPt = null;
          if(liveCtx) liveCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
          closeAllDropdowns(container);
          syncToolButtons(container);
        };
      });
    }
    document.removeEventListener('click', symbolPanelOutsideHandler);
    symbolPanelOutsideHandler = (e)=>{
      if(container.contains(e.target) && e.target.closest('.wb-dropdown-wrap')) return;
      closeAllDropdowns(container);
    };
    document.addEventListener('click', symbolPanelOutsideHandler);
    syncToolButtons(container);

    myStrokeStack = [];
    undoBtn = container.querySelector('#wb-undo');
    undoBtn.disabled = true;
    undoBtn.onclick = undoLastStroke;
    container.querySelector('#wb-export').onclick = ()=> exportBoardAsPng(container.querySelector('#wb-title'));
    keydownHandler = e=>{
      const cmd = e.metaKey || e.ctrlKey;
      if(cmd && e.key.toLowerCase() === 'z'){ e.preventDefault(); undoLastStroke(); }
    };
    document.addEventListener('keydown', keydownHandler);

    container.querySelector('#wb-clear').onclick = async ()=>{
      if(!confirm('Clear this whole board for everyone?')) return;
      strokeCache = {};
      myStrokeStack = [];
      updateUndoButton();
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
    watchCursors(boardId);
  }

  function syncToolButtons(container){
    const usesColor = currentTool !== 'eraser';
    container.querySelectorAll('[data-color]').forEach(b=> b.classList.toggle('wb-swatch-active', b.dataset.color === currentColor && usesColor));
    container.querySelectorAll('[data-size]').forEach(b=> b.classList.toggle('wb-size-active', Number(b.dataset.size) === currentSize));
    container.querySelectorAll('[data-tool]').forEach(b=> b.classList.toggle('cc-ctrl-active', b.dataset.tool === currentTool));
    const shapesToggle = container.querySelector('#wb-shapes-toggle');
    if(shapesToggle) shapesToggle.classList.toggle('cc-ctrl-active', SHAPE_TOOLS.includes(currentTool));
    const textToggle = container.querySelector('#wb-text-toggle');
    if(textToggle) textToggle.classList.toggle('cc-ctrl-active', currentTool === 'text');
    const symbolToggle = container.querySelector('#wb-symbols-toggle');
    if(symbolToggle) symbolToggle.classList.toggle('cc-ctrl-active', currentTool === 'symbol');
  }

  function closeAllDropdowns(container){
    container.querySelectorAll('.wb-dropdown-panel').forEach(p=> p.classList.add('hidden'));
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
      .forEach(s=> renderItem(bgCtx, s));
  }

  // Dispatches a stored item to the right drawing routine based on its tool.
  function renderItem(targetCtx, s){
    if(s.tool === 'text'){
      drawText(targetCtx, s.point, s.text, s.color, {
        fontPx: s.fontPx || fontPxForSize(s.size),
        fontFamily: s.fontFamily || FONT_FAMILIES[0].value,
        bold: !!s.bold, italic: !!s.italic, centered: !!s.center
      });
    }
    else if(SHAPE_TOOLS.includes(s.tool)) drawShape(targetCtx, s.tool, s.start, s.end, s.color, s.size);
    else drawStroke(targetCtx, s.points || [], s.color, s.size, s.tool);
  }

  function drawShape(targetCtx, tool, start, end, color, size){
    if(!start || !end) return;
    targetCtx.save();
    targetCtx.strokeStyle = color || '#1F3A2E';
    targetCtx.fillStyle = color || '#1F3A2E';
    targetCtx.lineWidth = size || 5;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    if(tool === 'line'){
      targetCtx.beginPath();
      targetCtx.moveTo(start.x, start.y);
      targetCtx.lineTo(end.x, end.y);
      targetCtx.stroke();
    }else if(tool === 'arrow'){
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const headLen = Math.max(14, (size || 5) * 3.2);
      targetCtx.beginPath();
      targetCtx.moveTo(start.x, start.y);
      targetCtx.lineTo(end.x, end.y);
      targetCtx.stroke();
      targetCtx.beginPath();
      targetCtx.moveTo(end.x, end.y);
      targetCtx.lineTo(end.x - headLen * Math.cos(angle - Math.PI / 7), end.y - headLen * Math.sin(angle - Math.PI / 7));
      targetCtx.lineTo(end.x - headLen * Math.cos(angle + Math.PI / 7), end.y - headLen * Math.sin(angle + Math.PI / 7));
      targetCtx.closePath();
      targetCtx.fill();
    }else if(tool === 'rect'){
      const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
      targetCtx.strokeRect(x, y, w, h);
    }else if(tool === 'circle'){
      const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2;
      const rx = Math.abs(end.x - start.x) / 2, ry = Math.abs(end.y - start.y) / 2;
      targetCtx.beginPath();
      targetCtx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
      targetCtx.stroke();
    }else if(tool === 'triangle'){
      const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
      targetCtx.beginPath();
      targetCtx.moveTo(x + w / 2, y);
      targetCtx.lineTo(x + w, y + h);
      targetCtx.lineTo(x, y + h);
      targetCtx.closePath();
      targetCtx.stroke();
    }
    targetCtx.restore();
  }

  // Font size scales off the S/M/L stroke-size selector — used as a fallback
  // for symbols and any older text items saved before per-item fontPx existed.
  function fontPxForSize(size){
    return Math.round((size || SIZES[1].px) * 4.5) + 12;
  }

  function drawText(targetCtx, point, text, color, opts){
    if(!point || !text) return;
    opts = opts || {};
    const fontPx = opts.fontPx || fontPxForSize();
    const fontFamily = opts.fontFamily || FONT_FAMILIES[0].value;
    const weight = opts.bold ? '700' : '600';
    const style = opts.italic ? 'italic' : 'normal';
    targetCtx.save();
    targetCtx.fillStyle = color || '#1F3A2E';
    targetCtx.font = `${style} ${weight} ${fontPx}px ${fontFamily}`;
    if(opts.centered){
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
    }else{
      targetCtx.textAlign = 'left';
      targetCtx.textBaseline = 'top';
    }
    targetCtx.fillText(text, point.x, point.y);
    targetCtx.restore();
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
      const pt = canvasPoint(e);
      if(currentStrokeId) extendStroke(pt);
      broadcastCursor(pt);
    });
    canvas.addEventListener('pointerleave', ()=> clearMyCursor());
    ['pointerup','pointercancel','pointerleave'].forEach(evt=>{
      canvas.addEventListener(evt, ()=>{ if(currentStrokeId) endStroke(); });
    });
  }

  function startStroke(pt){
    if(currentTool === 'text'){ addTextAt(pt); return; }
    if(currentTool === 'symbol'){ addSymbolAt(pt); return; }
    if(SHAPE_TOOLS.includes(currentTool)){
      shapeStartPt = pt;
      currentStrokeId = `${ctx.myId}-${Date.now()}-${Math.floor(Math.random()*1000)}`;
      liveCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      return;
    }
    currentStrokeId = `${ctx.myId}-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    currentStrokePoints = [pt];
    pendingFlush = [pt];
    liveCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    // Eraser punches directly into the committed background layer so the
    // removal is visible immediately, instead of waiting on a Firestore
    // round-trip to redraw() — that round-trip is what made erasing feel slow.
    drawDot(currentTool === 'eraser' ? bgCtx : liveCtx, pt, currentColor, currentSize, currentTool);
    strokesCol(activeBoardId).doc(currentStrokeId).set({
      color: currentColor, size: currentSize, tool: currentTool,
      points: [pt], createdBy: ctx.myId, createdByName: ctx.myName,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(), done: false
    }).catch(()=>{});
    myStrokeStack.push(currentStrokeId);
    updateUndoButton();
    flushTimer = setInterval(flushPending, FLUSH_MS);
  }

  // Text is placed with a single click via a prompt, rather than a drag —
  // it's created and committed to Firestore immediately, no live-drag phase.
  function addTextAt(pt){
    const text = prompt('Text to add to the board:');
    if(text === null || !text.trim()) return;
    const id = `${ctx.myId}-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    const item = {
      tool: 'text', point: pt, text: text.trim(), color: currentColor,
      fontPx: currentFontSize, fontFamily: currentFontFamily, bold: currentBold, italic: currentItalic, center: false,
      createdBy: ctx.myId, createdByName: ctx.myName,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(), done: true
    };
    strokesCol(activeBoardId).doc(id).set(item).catch(()=>{});
    myStrokeStack.push(id);
    updateUndoButton();
    // Fold in locally for an instant, gap-free appearance. Capture a fixed
    // timestamp now — an always-"live" one would re-sort this item on every
    // redraw and could flip it behind other strokes (e.g. an eraser).
    const nowMs = Date.now();
    strokeCache[id] = { id, ...item, createdAt: { toMillis: ()=> nowMs } };
    redraw();
  }

  function addSymbolAt(pt){
    const id = `${ctx.myId}-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    const item = {
      tool: 'text', point: pt, text: currentSymbol, color: currentColor, size: currentSize, center: true,
      createdBy: ctx.myId, createdByName: ctx.myName,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(), done: true
    };
    strokesCol(activeBoardId).doc(id).set(item).catch(()=>{});
    myStrokeStack.push(id);
    updateUndoButton();
    const nowMs = Date.now();
    strokeCache[id] = { id, ...item, createdAt: { toMillis: ()=> nowMs } };
    redraw();
  }

  function extendStroke(pt){
    if(SHAPE_TOOLS.includes(currentTool)){
      if(!shapeStartPt) return;
      liveCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      drawShape(liveCtx, currentTool, shapeStartPt, pt, currentColor, currentSize);
      currentStrokePoints = [pt]; // remembers the latest point for endStroke
      return;
    }
    const last = currentStrokePoints[currentStrokePoints.length - 1];
    currentStrokePoints.push(pt);
    pendingFlush.push(pt);
    const targetCtx = currentTool === 'eraser' ? bgCtx : liveCtx;
    targetCtx.save();
    targetCtx.globalCompositeOperation = currentTool === 'eraser' ? 'destination-out' : 'source-over';
    targetCtx.strokeStyle = currentColor;
    targetCtx.lineWidth = currentSize;
    targetCtx.lineCap = 'round';
    targetCtx.beginPath();
    targetCtx.moveTo(last.x, last.y);
    targetCtx.lineTo(pt.x, pt.y);
    targetCtx.stroke();
    targetCtx.restore();
  }

  function flushPending(){
    if(!activeBoardId || !currentStrokeId || pendingFlush.length === 0) return;
    const pts = pendingFlush; pendingFlush = [];
    strokesCol(activeBoardId).doc(currentStrokeId).update({
      points: firebase.firestore.FieldValue.arrayUnion(...pts)
    }).catch(()=>{});
  }

  function endStroke(){
    if(SHAPE_TOOLS.includes(currentTool)){
      const start = shapeStartPt;
      const end = currentStrokePoints[currentStrokePoints.length - 1] || start;
      shapeStartPt = null;
      liveCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      if(!start || !currentStrokeId){ currentStrokeId = null; currentStrokePoints = []; return; }
      const id = currentStrokeId;
      const item = {
        tool: currentTool, start, end, color: currentColor, size: currentSize,
        createdBy: ctx.myId, createdByName: ctx.myName,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(), done: true
      };
      strokesCol(activeBoardId).doc(id).set(item).catch(()=>{});
      myStrokeStack.push(id);
      updateUndoButton();
      const shapeNowMs = Date.now();
      strokeCache[id] = { id, ...item, createdAt: { toMillis: ()=> shapeNowMs } };
      redraw();
      currentStrokeId = null;
      currentStrokePoints = [];
      return;
    }
    clearInterval(flushTimer); flushTimer = null;
    flushPending();
    if(activeBoardId && currentStrokeId){
      strokesCol(activeBoardId).doc(currentStrokeId).update({ done: true }).catch(()=>{});
      boardsCol().doc(activeBoardId).update({ updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
    }
    // Fold the just-finished stroke into the local cache immediately so
    // there's no visible gap while we wait for our own snapshot echo back.
    // Timestamp is captured once, not re-evaluated on every future redraw.
    if(currentStrokeId){
      const penNowMs = Date.now();
      strokeCache[currentStrokeId] = {
        id: currentStrokeId, color: currentColor, size: currentSize, tool: currentTool,
        points: currentStrokePoints, createdAt: { toMillis: ()=> penNowMs }
      };
      redraw();
    }
    liveCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    currentStrokeId = null;
    currentStrokePoints = [];
    pendingFlush = [];
  }

  // Draws the live in-progress stroke on top of the committed background so
  // nothing mid-draw gets lost, then downloads the flattened result as a PNG.
  function exportBoardAsPng(titleEl){
    if(!bgCanvas) return;
    const out = document.createElement('canvas');
    out.width = CANVAS_W; out.height = CANVAS_H;
    const outCtx = out.getContext('2d');
    outCtx.drawImage(bgCanvas, 0, 0);
    if(liveCanvas) outCtx.drawImage(liveCanvas, 0, 0);
    const rawTitle = (titleEl && titleEl.textContent) ? titleEl.textContent.trim() : 'whiteboard';
    const safeName = rawTitle.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'whiteboard';
    const link = document.createElement('a');
    link.href = out.toDataURL('image/png');
    link.download = `${safeName}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function updateUndoButton(){
    if(undoBtn) undoBtn.disabled = myStrokeStack.length === 0;
  }

  // Removes only *my own* most recent stroke — never someone else's — so
  // undo can't be used to erase a classmate's work by mistake.
  async function undoLastStroke(){
    if(myStrokeStack.length === 0 || !activeBoardId) return;
    const id = myStrokeStack.pop();
    updateUndoButton();
    delete strokeCache[id];
    redraw();
    await strokesCol(activeBoardId).doc(id).delete().catch(()=>{});
    boardsCol().doc(activeBoardId).update({ updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
  }

  /* --------------------------- live cursor presence --------------------------- */
  // Broadcast my pointer position (throttled) so everyone sees a small
  // labeled dot tracking where I'm about to draw — a lightweight
  // single-doc-per-user write, cheap even at ~14 updates/sec.
  function broadcastCursor(pt){
    if(!activeBoardId) return;
    const now = Date.now();
    if(now - lastCursorWrite < CURSOR_WRITE_MS) return;
    lastCursorWrite = now;
    cursorsCol(activeBoardId).doc(ctx.myId).set({
      name: ctx.myName, x: pt.x, y: pt.y, color: colorForUser(ctx.myId),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(()=>{});
  }

  function clearMyCursor(){
    if(!activeBoardId) return;
    cursorsCol(activeBoardId).doc(ctx.myId).delete().catch(()=>{});
  }

  function watchCursors(boardId){
    cursorCache = {};
    unsubCursors = cursorsCol(boardId).onSnapshot(snap=>{
      snap.docChanges().forEach(change=>{
        if(change.doc.id === ctx.myId) return; // never render my own cursor
        if(change.type === 'removed'){ delete cursorCache[change.doc.id]; return; }
        cursorCache[change.doc.id] = { id: change.doc.id, ...change.doc.data() };
      });
      renderCursors();
    }, ()=>{});
    cursorSweepTimer = setInterval(()=>{
      const now = Date.now();
      let changed = false;
      Object.keys(cursorCache).forEach(id=>{
        if(now - tsVal(cursorCache[id].updatedAt) > CURSOR_STALE_MS){ delete cursorCache[id]; changed = true; }
      });
      if(changed) renderCursors();
    }, 3000);
  }

  function renderCursors(){
    if(!cursorLayerEl) return;
    const seen = new Set();
    Object.values(cursorCache).forEach(c=>{
      seen.add(c.id);
      let node = cursorEls[c.id];
      if(!node){
        node = el(`<div class="wb-cursor"><div class="wb-cursor-dot"></div><div class="wb-cursor-label"></div></div>`);
        cursorLayerEl.appendChild(node);
        cursorEls[c.id] = node;
      }
      node.style.left = `${(c.x / CANVAS_W) * 100}%`;
      node.style.top = `${(c.y / CANVAS_H) * 100}%`;
      node.querySelector('.wb-cursor-dot').style.background = c.color || '#1F3A2E';
      node.querySelector('.wb-cursor-label').textContent = c.name || 'Someone';
      node.querySelector('.wb-cursor-label').style.background = c.color || '#1F3A2E';
    });
    Object.keys(cursorEls).forEach(id=>{
      if(!seen.has(id)){ cursorEls[id].remove(); delete cursorEls[id]; }
    });
  }

  function teardownEditor(){
    if(unsubStrokes){ unsubStrokes(); unsubStrokes = null; }
    if(unsubCursors){ unsubCursors(); unsubCursors = null; }
    if(cursorSweepTimer){ clearInterval(cursorSweepTimer); cursorSweepTimer = null; }
    if(flushTimer){ clearInterval(flushTimer); flushTimer = null; }
    if(keydownHandler){ document.removeEventListener('keydown', keydownHandler); keydownHandler = null; }
    if(symbolPanelOutsideHandler){ document.removeEventListener('click', symbolPanelOutsideHandler); symbolPanelOutsideHandler = null; }
    clearMyCursor();
    activeBoardId = null;
    strokeCache = {};
    cursorCache = {};
    cursorEls = {};
    cursorLayerEl = null;
    currentStrokeId = null;
    myStrokeStack = [];
    undoBtn = null;
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