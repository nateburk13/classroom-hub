/* =========================================================================
   CLASSROOM WHITEBOARD — shared object-canvas module, used by teacher.html
   and student.html (and by call.js for the in-call overlay).

   OBJECT MODEL (v2): every item placed on a board — freehand drawing, a
   shape, a text box, an image — is a single Firestore document with the
   same envelope (x, y, w, h, zIndex, ...) so it can be selected, dragged,
   and resized the same way, like a shape in Publisher/PowerPoint rather
   than a flattened paint-program pixel.

   Data model (Firestore):
     classes/{classId}/whiteboards/{boardId}                — metadata doc
       { title, createdBy, createdByName, createdAt, updatedAt }
     classes/{classId}/whiteboards/{boardId}/objects/{id}    — one per object
       { type: 'path'|'shape'|'text'|'image',
         x, y, w, h,            // logical box, 0..1600 / 0..900
         zIndex,
         // path:  points:[{x,y}] normalized 0..1 within the box, color, size
         // shape: shapeType ('line'|'arrow'|'rect'|'circle'|'triangle'),
         //        color, size, flipX, flipY
         // text:  html (sanitized rich text incl. <ul>/<ol>), color,
         //        fontFamily, fontPx, bold, italic
         // image: src (data URL)
         createdBy, createdByName, createdAt, updatedAt }

   classes/{classId}/whiteboards/{boardId}/strokes/{id} is the OLD (v1)
   flattened-stroke schema. If a board still only has v1 strokes, they are
   migrated once into v2 objects the first time the board is opened.

   Public API (attached to window.Whiteboard) — unchanged from v1:
     init({ classId, myId, myName, myRole })
     teardown()
     mountPage(container)
     openOverlay(boardKey, label)
     closeOverlay()
   ========================================================================= */
(function(){
  const CANVAS_W = 1600, CANVAS_H = 900; // fixed logical drawing surface (16:9)
  const COLORS = ['#1F3A2E', '#C1502E', '#2B6CB0', '#B87A1F', '#6B3FA0', '#000000'];
  const SIZES = [{ label: 'S', px: 3 }, { label: 'M', px: 7 }, { label: 'L', px: 14 }];
  const SHAPE_DEFS = [
    { tool: 'line',     label: 'Line',      icon: '\u2571' },
    { tool: 'arrow',    label: 'Arrow',     icon: '\u2192' },
    { tool: 'rect',     label: 'Rectangle', icon: '\u25AD' },
    { tool: 'circle',   label: 'Circle',    icon: '\u25EF' },
    { tool: 'triangle', label: 'Triangle',  icon: '\u25B3' }
  ];
  const SHAPE_TOOLS = SHAPE_DEFS.map(s=> s.tool);
  const FONT_FAMILIES = [
    { label: 'Sans',  value: "'Inter', sans-serif" },
    { label: 'Serif', value: "'Roboto Slab', serif" },
    { label: 'Mono',  value: "'JetBrains Mono', monospace" }
  ];
  const FONT_SIZES = [16, 20, 24, 32, 40, 56, 72];
  const SYMBOL_GROUPS = [
    { label: 'Marks',  items: ['\u2605','\u2606','\u2764','\u2713','\u2717','\u2757','\u2753','\u203C'] },
    { label: 'Arrows', items: ['\u2191','\u2193','\u2190','\u2192','\u2196','\u2197','\u2198','\u2199'] },
    { label: 'Shapes', items: ['\u25CF','\u25CB','\u25A0','\u25A1','\u25B2','\u25B3','\u25C6','\u25C7'] },
    { label: 'Math',   items: ['+','\u2212','\u00D7','\u00F7','=','\u2260','%','\u00B0'] },
    { label: 'Misc',   items: ['\u2600','\u2601','\u2602','\u2603','\u26A1','\u2699','\u266A','\u263A'] }
  ];
  const MIN_OBJ = 24;              // smallest a box can be dragged/resized to
  const IMAGE_MAX_PX = 1100;       // longest side, in raw pixels, before compression
  const IMAGE_MAX_BYTES = 900000;  // stay safely under Firestore's 1MiB doc cap
  const ALLOWED_TEXT_TAGS = new Set(['B','STRONG','I','EM','U','UL','OL','LI','BR','DIV','SPAN','P']);

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
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
  function boardsCol(){ return db.collection('classes').doc(ctx.classId).collection('whiteboards'); }
  function objectsCol(boardId){ return boardsCol().doc(boardId).collection('objects'); }
  function legacyStrokesCol(boardId){ return boardsCol().doc(boardId).collection('strokes'); }
  function cursorsCol(boardId){ return boardsCol().doc(boardId).collection('cursors'); }

  // Surfaces write failures instead of swallowing them — a silently-rejected
  // write (e.g. blocked by Firestore security rules) shows up locally at
  // first (optimistic UI) then vanishes moments later when the SDK rolls
  // it back, which otherwise looks like an unexplained disappearing item.
  let writeErrorShown = false;
  function reportWriteError(err){
    console.error('Whiteboard save failed:', err);
    if(writeErrorShown) return;
    writeErrorShown = true;
    const code = err && err.code;
    const reasonLine = code === 'permission-denied'
      ? 'This usually means your Firestore security rules are rejecting this item. ' +
        'Check Firebase Console \u2192 Firestore Database \u2192 Rules for the ' +
        'classes/{classId}/whiteboards/{boardId}/objects path.'
      : 'This looks like a connection problem rather than a rules problem \u2014 check your internet connection. ' +
        'If it keeps happening, check Firebase Console \u2192 Firestore Database \u2192 Rules just in case.';
    alert('This didn\'t save to the board and will disappear again shortly.\n\n' +
      'Reason (' + (code || 'unknown') + '): ' + (err && err.message ? err.message : err) + '\n\n' +
      reasonLine);
  }

  // Retries a single write once after a short delay before giving up. This
  // absorbs the brief window right after publishing new Firestore rules
  // (or the very first request of a fresh page load) where a request can
  // occasionally be evaluated before the rules update has fully propagated
  // — without it, that shows up as a one-off, seemingly-random permission
  // error on the very first thing a user draws.
  function writeWithRetry(writeFn){
    return writeFn().catch(err=>{
      if(err && err.code === 'permission-denied'){
        return new Promise(resolve=> setTimeout(resolve, 900)).then(writeFn);
      }
      throw err;
    });
  }
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
        html += `<div class="empty"><h3>No whiteboards yet</h3><p>Start one — everyone in the class can add and move things together, and it stays saved for review.</p></div>`;
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

    container._wbTeardown = ()=>{ if(unsubList) unsubList(); teardownEditor(); };
    watchList();
  }

  async function deleteCollection(colRef){
    const snap = await colRef.get();
    const chunks = [];
    for(let i=0;i<snap.docs.length;i+=400) chunks.push(snap.docs.slice(i,i+400));
    for(const chunk of chunks){
      const batch = db.batch();
      chunk.forEach(d=> batch.delete(d.ref));
      await batch.commit().catch(()=>{});
    }
  }

  async function deleteBoard(boardId){
    await deleteCollection(objectsCol(boardId));
    await deleteCollection(legacyStrokesCol(boardId));
    await boardsCol().doc(boardId).delete().catch(()=>{});
  }

  /* --------------------------- shared editor (list mode + overlay mode) --------------------------- */
  let activeBoardId = null;
  let unsubObjects = null;
  let objectCache = {};      // id -> object data, as synced from Firestore
  let objectEls = {};        // id -> wrapper DOM node
  let objLayerEl = null;
  let previewLayerEl = null; // temp SVG for in-progress pen strokes / shape drags
  let currentColor = COLORS[0];
  let currentSize = SIZES[1].px;
  let currentTool = 'select'; // 'select' | 'pen' | 'eraser' | 'text' | 'symbol' | 'image' | shape tool name
  let currentSymbol = SYMBOL_GROUPS[0].items[0];
  let currentFontFamily = FONT_FAMILIES[0].value;
  let currentFontSize = 32;
  let currentBold = false;
  let currentItalic = false;
  let selectedId = null;
  let editingId = null;      // object currently being typed into
  let pendingRebuild = false;
  let dragState = null;      // { id, mode:'move'|'resize', ... } while pointer is down on an object
  let drawState = null;      // { kind:'pen'|shapeTool, points/start } while drawing on empty canvas
  let myCreateStack = [];    // ids of objects *I* created on the current board, in order — powers Undo
  let undoBtn = null;
  let deleteBtn = null;
  let frontBtn = null;
  let keydownHandler = null;
  let symbolPanelOutsideHandler = null;
  let fileInputEl = null;

  // ------- live cursor presence -------
  const CURSOR_COLORS = ['#C1502E', '#2B6CB0', '#B87A1F', '#6B3FA0', '#3B6D40', '#B8336A'];
  const CURSOR_WRITE_MS = 70;
  const CURSOR_STALE_MS = 8000;
  let unsubCursors = null;
  let cursorCache = {};
  let cursorEls = {};
  let cursorLayerEl = null;
  let lastCursorWrite = 0;
  let cursorSweepTimer = null;
  let wrapEl = null;

  function buildEditor(container, boardId, opts){
    teardownEditor();
    activeBoardId = boardId;
    const colorSwatches = COLORS.map(c=> `<button class="wb-swatch" data-color="${c}" style="background:${c};${c==='#000000'?'border-color:var(--line);':''}" aria-label="Color ${c}"></button>`).join('');
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
            <button class="btn small" id="wb-select" data-tool="select" title="Select / move / resize">\u2196 Select</button>
            <button class="btn small" id="wb-pen" data-tool="pen" title="Freehand pen">\u270F\uFE0F Pen</button>
            <button class="btn small" id="wb-eraser" data-tool="eraser" title="Click an item to delete it">\u{1F9FD} Eraser</button>

            <div class="wb-swatches">${colorSwatches}</div>
            <div class="wb-sizes">${sizeButtons}</div>

            <div class="wb-dropdown-wrap">
              <button class="btn small wb-dropdown-toggle" id="wb-shapes-toggle" title="Insert a shape">\u25AD Shapes \u25BE</button>
              <div class="wb-dropdown-panel hidden" id="wb-shapes-panel">${shapeItems}</div>
            </div>

            <div class="wb-dropdown-wrap">
              <button class="btn small wb-dropdown-toggle" id="wb-text-toggle" title="Add a text box">\u{1F524} Text \u25BE</button>
              <div class="wb-dropdown-panel wb-text-panel hidden" id="wb-text-panel">
                <label>Font</label>
                <select id="wb-font-family">${fontOptions}</select>
                <label>Size</label>
                <select id="wb-font-size">${sizeOptions}</select>
                <div class="wb-text-style-row">
                  <button class="btn small" id="wb-bold-toggle" title="Bold"><b>B</b></button>
                  <button class="btn small" id="wb-italic-toggle" title="Italic"><i>I</i></button>
                  <button class="btn small" id="wb-bullet-toggle" title="Bullet list">\u2022\u2261</button>
                  <button class="btn small" id="wb-number-toggle" title="Numbered list">1.\u2261</button>
                </div>
                <p class="wb-dropdown-hint">Click the board to place a text box. Use the list buttons while typing.</p>
              </div>
            </div>

            <div class="wb-dropdown-wrap">
              <button class="btn small wb-dropdown-toggle" id="wb-symbols-toggle" title="Insert a symbol">\u2733 Symbols \u25BE</button>
              <div class="wb-dropdown-panel wb-symbol-panel hidden" id="wb-symbol-panel">${symbolGroups}</div>
            </div>

            <button class="btn small" id="wb-image-btn" title="Insert an image">\u{1F5BC}\uFE0F Image</button>

            <button class="btn small hidden" id="wb-front" title="Bring to front">\u2B06 Front</button>
            <button class="btn small danger hidden" id="wb-delete" title="Delete selected (Del)">Delete</button>
            <button class="btn small" id="wb-undo" title="Undo your last add (Ctrl/Cmd+Z)">\u21B6 Undo</button>
            <button class="btn small" id="wb-export" title="Download this board as an image">\u2B07 PNG</button>
            <button class="btn small danger" id="wb-clear">Clear</button>
            ${opts.onCloseOverlay ? `<button class="btn small" id="wb-overlay-close">Close</button>` : ''}
          </div>
        </div>
        <div class="wb-canvas-wrap" id="wb-wrap">
          <div id="wb-objects-layer" class="wb-objects-layer"></div>
          <svg id="wb-preview-layer" class="wb-preview-layer" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" preserveAspectRatio="none"></svg>
          <div id="wb-cursor-layer" class="wb-cursor-layer"></div>
        </div>
      </div>`;

    wrapEl = container.querySelector('#wb-wrap');
    objLayerEl = container.querySelector('#wb-objects-layer');
    previewLayerEl = container.querySelector('#wb-preview-layer');
    cursorLayerEl = container.querySelector('#wb-cursor-layer');

    fileInputEl = document.createElement('input');
    fileInputEl.type = 'file';
    fileInputEl.accept = 'image/*';
    fileInputEl.style.display = 'none';
    fileInputEl.onchange = ()=>{ if(fileInputEl.files[0]) handleImageFile(fileInputEl.files[0]); fileInputEl.value = ''; };
    container.appendChild(fileInputEl);

    container.querySelectorAll('[data-color]').forEach(b=>{
      b.classList.toggle('wb-swatch-active', b.dataset.color === currentColor);
      b.onclick = ()=>{
        currentColor = b.dataset.color;
        if(editingId){ applyTextStyle({ color: currentColor }); }
        syncToolButtons(container);
      };
    });
    container.querySelectorAll('[data-size]').forEach(b=>{
      b.classList.toggle('wb-size-active', Number(b.dataset.size) === currentSize);
      b.onclick = ()=>{ currentSize = Number(b.dataset.size); syncToolButtons(container); };
    });

    // ---- Select / Pen / Eraser ----
    ['wb-select','wb-pen','wb-eraser'].forEach(id=>{
      const b = container.querySelector('#'+id);
      b.onclick = ()=>{ setTool(b.dataset.tool, container); };
    });

    // ---- Shapes dropdown ----
    const shapesToggle = container.querySelector('#wb-shapes-toggle');
    const shapesPanel = container.querySelector('#wb-shapes-panel');
    shapesToggle.onclick = (e)=>{ e.stopPropagation(); const willOpen = shapesPanel.classList.contains('hidden'); closeAllDropdowns(container); if(willOpen) shapesPanel.classList.remove('hidden'); };
    shapesPanel.querySelectorAll('[data-tool]').forEach(b=>{
      b.onclick = ()=>{ setTool(b.dataset.tool, container); closeAllDropdowns(container); };
    });

    // ---- Text dropdown ----
    const textToggle = container.querySelector('#wb-text-toggle');
    const textPanel = container.querySelector('#wb-text-panel');
    textToggle.onclick = (e)=>{
      e.stopPropagation();
      const willOpen = textPanel.classList.contains('hidden');
      setTool('text', container);
      closeAllDropdowns(container);
      if(willOpen) textPanel.classList.remove('hidden');
    };
    const fontSelect = container.querySelector('#wb-font-family');
    const sizeSelect = container.querySelector('#wb-font-size');
    const boldBtn = container.querySelector('#wb-bold-toggle');
    const italicBtn = container.querySelector('#wb-italic-toggle');
    const bulletBtn = container.querySelector('#wb-bullet-toggle');
    const numberBtn = container.querySelector('#wb-number-toggle');
    fontSelect.value = currentFontFamily;
    sizeSelect.value = String(currentFontSize);
    boldBtn.classList.toggle('cc-ctrl-active', currentBold);
    italicBtn.classList.toggle('cc-ctrl-active', currentItalic);
    fontSelect.onchange = ()=>{ currentFontFamily = fontSelect.value; applyTextStyle({ fontFamily: currentFontFamily }); };
    sizeSelect.onchange = ()=>{ currentFontSize = Number(sizeSelect.value); applyTextStyle({ fontPx: currentFontSize }); };
    boldBtn.onclick = (e)=>{ e.stopPropagation(); currentBold = !currentBold; boldBtn.classList.toggle('cc-ctrl-active', currentBold); applyTextStyle({ bold: currentBold }); };
    italicBtn.onclick = (e)=>{ e.stopPropagation(); currentItalic = !currentItalic; italicBtn.classList.toggle('cc-ctrl-active', currentItalic); applyTextStyle({ italic: currentItalic }); };
    bulletBtn.onclick = (e)=>{ e.stopPropagation(); if(editingId) document.execCommand('insertUnorderedList'); };
    numberBtn.onclick = (e)=>{ e.stopPropagation(); if(editingId) document.execCommand('insertOrderedList'); };
    textPanel.onclick = (e)=> e.stopPropagation();

    // ---- Symbols dropdown ----
    const symbolToggle = container.querySelector('#wb-symbols-toggle');
    const symbolPanel = container.querySelector('#wb-symbol-panel');
    symbolToggle.onclick = (e)=>{ e.stopPropagation(); const willOpen = symbolPanel.classList.contains('hidden'); closeAllDropdowns(container); if(willOpen) symbolPanel.classList.remove('hidden'); };
    symbolPanel.querySelectorAll('[data-symbol]').forEach(b=>{
      b.onclick = ()=>{ currentSymbol = b.dataset.symbol; setTool('symbol', container); closeAllDropdowns(container); };
    });

    document.removeEventListener('click', symbolPanelOutsideHandler);
    symbolPanelOutsideHandler = (e)=>{
      if(container.contains(e.target) && e.target.closest('.wb-dropdown-wrap')) return;
      closeAllDropdowns(container);
    };
    document.addEventListener('click', symbolPanelOutsideHandler);

    // ---- Image ----
    container.querySelector('#wb-image-btn').onclick = ()=> fileInputEl.click();

    // ---- Selection actions ----
    deleteBtn = container.querySelector('#wb-delete');
    frontBtn = container.querySelector('#wb-front');
    deleteBtn.onclick = ()=>{ if(selectedId) removeObject(selectedId); };
    frontBtn.onclick = ()=>{ if(selectedId) bringToFront(selectedId); };

    myCreateStack = [];
    undoBtn = container.querySelector('#wb-undo');
    undoBtn.disabled = true;
    undoBtn.onclick = undoLastCreate;
    container.querySelector('#wb-export').onclick = ()=> exportBoardAsPng(container.querySelector('#wb-title'));

    keydownHandler = e=>{
      const cmd = e.metaKey || e.ctrlKey;
      if(cmd && e.key.toLowerCase() === 'z'){ e.preventDefault(); undoLastCreate(); return; }
      if((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !editingId){
        const tag = document.activeElement && document.activeElement.tagName;
        if(tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        removeObject(selectedId);
        return;
      }
      if(e.key === 'Escape'){ if(editingId) stopEditingText(editingId); else selectObject(null); }
    };
    document.addEventListener('keydown', keydownHandler);

    container.querySelector('#wb-clear').onclick = async ()=>{
      if(!confirm('Clear this whole board for everyone?')) return;
      objectCache = {}; myCreateStack = []; selectedId = null; editingId = null;
      updateUndoButton(); renderSelectionUI(); rebuildObjectsLayer();
      await deleteCollection(objectsCol(boardId));
      await deleteCollection(legacyStrokesCol(boardId));
      boardsCol().doc(boardId).update({ updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
    };

    const titleEl = container.querySelector('#wb-title');
    titleEl.onclick = async ()=>{
      const next = prompt('Rename whiteboard:', titleEl.textContent);
      if(next === null || !next.trim()) return;
      titleEl.textContent = next.trim();
      await boardsCol().doc(boardId).update({ title: next.trim() }).catch(()=>{});
    };
    const backBtn = container.querySelector('#wb-back');
    if(backBtn) backBtn.onclick = ()=>{ teardownEditor(); if(opts.onClose) opts.onClose(); };
    const overlayCloseBtn = container.querySelector('#wb-overlay-close');
    if(overlayCloseBtn) overlayCloseBtn.onclick = ()=>{ if(opts.onCloseOverlay) opts.onCloseOverlay(); };

    wireCanvasPointerEvents();
    syncToolButtons(container);
    renderSelectionUI();
    loadBoard(boardId);
    watchCursors(boardId);
  }

  function setTool(tool, container){
    currentTool = tool;
    if(editingId) stopEditingText(editingId);
    selectObject(null);
    if(container) syncToolButtons(container);
  }

  function syncToolButtons(container){
    container.querySelectorAll('#wb-select,#wb-pen,#wb-eraser').forEach(b=> b.classList.toggle('cc-ctrl-active', b.dataset.tool === currentTool));
    container.querySelectorAll('[data-color]').forEach(b=> b.classList.toggle('wb-swatch-active', b.dataset.color === currentColor));
    container.querySelectorAll('[data-size]').forEach(b=> b.classList.toggle('wb-size-active', Number(b.dataset.size) === currentSize));
    if(wrapEl) wrapEl.classList.toggle('wb-tool-select', currentTool === 'select');
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

  /* --------------------------- loading + migration --------------------------- */
  async function loadBoard(boardId){
    const existing = await objectsCol(boardId).limit(1).get().catch(()=> null);
    if(existing && existing.empty){
      const legacy = await legacyStrokesCol(boardId).get().catch(()=> null);
      if(legacy && !legacy.empty){
        await migrateLegacyStrokes(boardId, legacy.docs);
      }
    }
    if(activeBoardId === boardId) watchObjects(boardId);
  }

  // One-time conversion of the old flattened-stroke schema into v2 objects,
  // so boards drawn before this upgrade keep their content.
  async function migrateLegacyStrokes(boardId, docs){
    let z = 1;
    const items = docs
      .map(d=> ({ id: d.id, ...d.data() }))
      .sort((a,b)=> tsVal(a.createdAt) - tsVal(b.createdAt));
    const chunks = [];
    for(let i=0;i<items.length;i+=400) chunks.push(items.slice(i,i+400));
    for(const chunk of chunks){
      const batch = db.batch();
      chunk.forEach(s=>{
        const obj = legacyItemToObject(s, z++);
        if(obj) batch.set(objectsCol(boardId).doc(), obj);
      });
      await batch.commit().catch(()=>{});
    }
  }

  function legacyItemToObject(s, z){
    const base = {
      zIndex: z, createdBy: s.createdBy || 'legacy', createdByName: s.createdByName || 'Legacy',
      createdAt: s.createdAt || firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if(s.tool === 'text'){
      const fontPx = s.fontPx || 24;
      const w = clamp((s.text || '').length * fontPx * 0.62 + 24, 60, CANVAS_W);
      const h = fontPx * 1.6 + 20;
      const x = s.center ? clamp(s.point.x - w/2, 0, CANVAS_W - w) : clamp(s.point.x, 0, CANVAS_W - w);
      const y = s.center ? clamp(s.point.y - h/2, 0, CANVAS_H - h) : clamp(s.point.y, 0, CANVAS_H - h);
      return { ...base, type: 'text', x, y, w, h,
        html: `<div>${esc(s.text || '')}</div>`, color: s.color || '#1F3A2E',
        fontFamily: s.fontFamily || FONT_FAMILIES[0].value, fontPx, bold: !!s.bold, italic: !!s.italic };
    }
    if(SHAPE_TOOLS.includes(s.tool)){
      if(!s.start || !s.end) return null;
      const x = Math.min(s.start.x, s.end.x), y = Math.min(s.start.y, s.end.y);
      const w = Math.max(Math.abs(s.end.x - s.start.x), MIN_OBJ), h = Math.max(Math.abs(s.end.y - s.start.y), MIN_OBJ);
      return { ...base, type: 'shape', shapeType: s.tool, x, y, w, h,
        color: s.color || '#1F3A2E', size: s.size || 5,
        flipX: s.end.x < s.start.x, flipY: s.end.y < s.start.y };
    }
    if(s.tool === 'pen' || !s.tool){
      const pts = s.points || [];
      if(pts.length === 0) return null;
      const xs = pts.map(p=> p.x), ys = pts.map(p=> p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      const w = Math.max(Math.max(...xs) - x, MIN_OBJ), h = Math.max(Math.max(...ys) - y, MIN_OBJ);
      const norm = pts.map(p=> ({ x: (p.x - x) / w, y: (p.y - y) / h }));
      return { ...base, type: 'path', x, y, w, h, points: norm, color: s.color || '#1F3A2E', size: s.size || 5 };
    }
    return null; // eraser strokes from the old model don't map to an object
  }

  /* --------------------------- Firestore sync --------------------------- */
  function watchObjects(boardId){
    objectCache = {};
    unsubObjects = objectsCol(boardId).onSnapshot(snap=>{
      snap.docChanges().forEach(change=>{
        if(change.type === 'removed'){
          delete objectCache[change.doc.id];
          const node = objectEls[change.doc.id];
          if(node){ node.remove(); delete objectEls[change.doc.id]; }
          if(selectedId === change.doc.id) selectObject(null);
          return;
        }
        objectCache[change.doc.id] = { id: change.doc.id, ...change.doc.data({ serverTimestamps: 'estimate' }) };
      });
      rebuildObjectsLayer();
    }, ()=>{});
  }

  function nextZIndex(){
    const zs = Object.values(objectCache).map(o=> o.zIndex || 0);
    return (zs.length ? Math.max(...zs) : 0) + 1;
  }

  function createObject(partial){
    if(!activeBoardId) return null;
    const id = objectsCol(activeBoardId).doc().id;
    const data = {
      zIndex: nextZIndex(), createdBy: ctx.myId, createdByName: ctx.myName,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      ...partial
    };
    objectCache[id] = { id, ...data, createdAt: { toMillis: ()=> Date.now() } };
    writeWithRetry(()=> objectsCol(activeBoardId).doc(id).set(data)).catch(reportWriteError);
    myCreateStack.push(id);
    updateUndoButton();
    rebuildObjectsLayer();
    boardsCol().doc(activeBoardId).update({ updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
    return id;
  }

  function patchObject(id, patch, opts){
    if(!objectCache[id]) return;
    Object.assign(objectCache[id], patch);
    if(!opts || !opts.skipRemote){
      writeWithRetry(()=> objectsCol(activeBoardId).doc(id).update({ ...patch, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })).catch(reportWriteError);
    }
  }

  function removeObject(id){
    if(!objectCache[id]) return;
    delete objectCache[id];
    const node = objectEls[id]; if(node){ node.remove(); delete objectEls[id]; }
    if(selectedId === id) selectObject(null);
    if(editingId === id) editingId = null;
    objectsCol(activeBoardId).doc(id).delete().catch(()=>{});
  }

  function bringToFront(id){
    if(!objectCache[id]) return;
    patchObject(id, { zIndex: nextZIndex() });
    rebuildObjectsLayer();
  }

  async function undoLastCreate(){
    if(myCreateStack.length === 0 || !activeBoardId) return;
    const id = myCreateStack.pop();
    updateUndoButton();
    removeObject(id);
  }
  function updateUndoButton(){ if(undoBtn) undoBtn.disabled = myCreateStack.length === 0; }

  /* --------------------------- rendering --------------------------- */
  function rebuildObjectsLayer(){
    if(editingId){ pendingRebuild = true; return; }
    if(!objLayerEl) return;
    const ids = Object.keys(objectCache);
    // remove stale nodes
    Object.keys(objectEls).forEach(id=>{ if(!objectCache[id]){ objectEls[id].remove(); delete objectEls[id]; } });
    // sorted by zIndex so DOM order matches stacking order
    ids.sort((a,b)=> (objectCache[a].zIndex||0) - (objectCache[b].zIndex||0)).forEach(id=>{
      const obj = objectCache[id];
      let node = objectEls[id];
      if(!node){ node = buildObjectNode(id); objectEls[id] = node; objLayerEl.appendChild(node); }
      else{ objLayerEl.appendChild(node); } // reorder
      positionObjectNode(node, obj);
      refreshObjectContent(node, obj);
    });
    renderSelectionUI();
  }

  function positionObjectNode(node, obj){
    node.style.left = (obj.x / CANVAS_W * 100) + '%';
    node.style.top = (obj.y / CANVAS_H * 100) + '%';
    node.style.width = (obj.w / CANVAS_W * 100) + '%';
    node.style.height = (obj.h / CANVAS_H * 100) + '%';
  }

  function buildObjectNode(id){
    const node = document.createElement('div');
    node.className = 'wb-obj';
    node.dataset.id = id;
    node.innerHTML = `<div class="wb-obj-content"></div>
      <div class="wb-obj-handle wb-h-nw" data-h="nw"></div>
      <div class="wb-obj-handle wb-h-ne" data-h="ne"></div>
      <div class="wb-obj-handle wb-h-sw" data-h="sw"></div>
      <div class="wb-obj-handle wb-h-se" data-h="se"></div>`;
    node.addEventListener('pointerdown', (e)=> onObjectPointerDown(e, id));
    node.addEventListener('pointerenter', ()=>{ if(currentTool === 'eraser' && drawState) removeObject(id); });
    node.addEventListener('click', (e)=>{ e.stopPropagation(); });
    node.addEventListener('dblclick', (e)=>{
      e.stopPropagation();
      const obj = objectCache[id];
      if(obj && obj.type === 'text') startEditingText(id);
    });
    return node;
  }

  function refreshObjectContent(node, obj){
    if(node === objectEls[editingId]) return; // don't clobber a live edit
    const content = node.querySelector('.wb-obj-content');
    node.dataset.type = obj.type;
    if(obj.type === 'path'){
      const pts = (obj.points||[]).map(p=> `${(p.x*100).toFixed(2)},${(p.y*100).toFixed(2)}`).join(' ');
      content.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="wb-obj-svg">
        <polyline points="${pts}" fill="none" stroke="${esc(obj.color||'#1F3A2E')}" stroke-width="${(obj.size||5)}" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    }else if(obj.type === 'shape'){
      content.innerHTML = shapeSvg(obj);
    }else if(obj.type === 'image'){
      content.innerHTML = `<img src="${obj.src}" draggable="false" class="wb-obj-img" alt="">`;
    }else if(obj.type === 'text'){
      content.innerHTML = `<div class="wb-obj-text" style="font-family:${obj.fontFamily||FONT_FAMILIES[0].value};font-size:${obj.fontPx||24}px;font-weight:${obj.bold?700:600};font-style:${obj.italic?'italic':'normal'};color:${obj.color||'#1F3A2E'};">${sanitizeTextHtml(obj.html || '')}</div>`;
    }
  }

  function shapeSvg(obj){
    const x1 = obj.flipX ? 100 : 0, x2 = obj.flipX ? 0 : 100;
    const y1 = obj.flipY ? 100 : 0, y2 = obj.flipY ? 0 : 100;
    const color = esc(obj.color || '#1F3A2E');
    const sw = obj.size || 5;
    if(obj.shapeType === 'line'){
      return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="wb-obj-svg"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}" vector-effect="non-scaling-stroke" stroke-linecap="round"/></svg>`;
    }
    if(obj.shapeType === 'arrow'){
      const angle = Math.atan2(y2-y1, x2-x1);
      const headLen = 12;
      const hx1 = x2 - headLen*Math.cos(angle - Math.PI/7), hy1 = y2 - headLen*Math.sin(angle - Math.PI/7);
      const hx2 = x2 - headLen*Math.cos(angle + Math.PI/7), hy2 = y2 - headLen*Math.sin(angle + Math.PI/7);
      return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="wb-obj-svg">
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}" vector-effect="non-scaling-stroke" stroke-linecap="round"/>
        <polygon points="${x2},${y2} ${hx1},${hy1} ${hx2},${hy2}" fill="${color}"/>
      </svg>`;
    }
    if(obj.shapeType === 'rect'){
      return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="wb-obj-svg"><rect x="1" y="1" width="98" height="98" fill="none" stroke="${color}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/></svg>`;
    }
    if(obj.shapeType === 'circle'){
      return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="wb-obj-svg"><ellipse cx="50" cy="50" rx="48" ry="48" fill="none" stroke="${color}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/></svg>`;
    }
    if(obj.shapeType === 'triangle'){
      return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="wb-obj-svg"><polygon points="50,2 98,98 2,98" fill="none" stroke="${color}" stroke-width="${sw}" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
    }
    return '';
  }

  function sanitizeTextHtml(html){
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    (function clean(node){
      [...node.childNodes].forEach(child=>{
        if(child.nodeType === 1){
          if(!ALLOWED_TEXT_TAGS.has(child.tagName)){
            const text = document.createTextNode(child.textContent);
            node.replaceChild(text, child);
            return;
          }
          [...child.attributes].forEach(a=> child.removeAttribute(a.name));
          clean(child);
        }
      });
    })(tmp);
    return tmp.innerHTML;
  }

  /* --------------------------- selection UI --------------------------- */
  function selectObject(id){
    selectedId = id;
    renderSelectionUI();
  }
  function renderSelectionUI(){
    Object.entries(objectEls).forEach(([id, node])=> node.classList.toggle('wb-obj-selected', id === selectedId));
    if(deleteBtn) deleteBtn.classList.toggle('hidden', !selectedId);
    if(frontBtn) frontBtn.classList.toggle('hidden', !selectedId);
  }

  /* --------------------------- text editing --------------------------- */
  function startEditingText(id){
    const node = objectEls[id]; if(!node) return;
    editingId = id;
    selectObject(id);
    const div = node.querySelector('.wb-obj-text');
    div.contentEditable = 'true';
    div.focus();
    placeCaretAtEnd(div);
    const onBlur = ()=>{ stopEditingText(id); };
    div._onBlur = onBlur;
    div.addEventListener('blur', onBlur, { once: true });
  }
  function placeCaretAtEnd(el){
    const range = document.createRange();
    range.selectNodeContents(el); range.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }
  function stopEditingText(id){
    const node = objectEls[id];
    if(node){
      const div = node.querySelector('.wb-obj-text');
      if(div){
        div.contentEditable = 'false';
        const clean = sanitizeTextHtml(div.innerHTML);
        patchObject(id, { html: clean });
      }
    }
    editingId = null;
    if(pendingRebuild){ pendingRebuild = false; rebuildObjectsLayer(); }
  }
  function applyTextStyle(patch){
    if(!editingId) return;
    patchObject(editingId, patch);
    const node = objectEls[editingId];
    const div = node && node.querySelector('.wb-obj-text');
    if(!div) return;
    if(patch.color !== undefined) div.style.color = patch.color;
    if(patch.fontFamily !== undefined) div.style.fontFamily = patch.fontFamily;
    if(patch.fontPx !== undefined) div.style.fontSize = patch.fontPx + 'px';
    if(patch.bold !== undefined) div.style.fontWeight = patch.bold ? '700' : '600';
    if(patch.italic !== undefined) div.style.fontStyle = patch.italic ? 'italic' : 'normal';
  }

  /* --------------------------- pointer interaction --------------------------- */
  function canvasPoint(e){
    const rect = wrapEl.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * CANVAS_W;
    const y = (e.clientY - rect.top) / rect.height * CANVAS_H;
    return { x: clamp(x, 0, CANVAS_W), y: clamp(y, 0, CANVAS_H) };
  }

  function wireCanvasPointerEvents(){
    wrapEl.style.touchAction = 'none';
    wrapEl.addEventListener('pointerdown', onCanvasPointerDown);
    wrapEl.addEventListener('pointermove', onCanvasPointerMove);
    ['pointerup','pointercancel'].forEach(evt=> wrapEl.addEventListener(evt, onCanvasPointerUp));
    wrapEl.addEventListener('pointerleave', ()=> clearMyCursor());
  }

  function onCanvasPointerDown(e){
    if(e.target.closest('.wb-obj')) return; // handled by the object itself
    const pt = canvasPoint(e);
    if(editingId) stopEditingText(editingId);

    if(currentTool === 'select'){ selectObject(null); return; }

    if(currentTool === 'pen'){
      wrapEl.setPointerCapture(e.pointerId);
      drawState = { kind: 'pen', points: [pt] };
      return;
    }
    if(currentTool === 'eraser'){
      wrapEl.setPointerCapture(e.pointerId);
      drawState = { kind: 'eraser' };
      return;
    }
    if(SHAPE_TOOLS.includes(currentTool)){
      wrapEl.setPointerCapture(e.pointerId);
      drawState = { kind: currentTool, start: pt, end: pt };
      return;
    }
    if(currentTool === 'text'){
      const w = 320, h = 96;
      const x = clamp(pt.x - w/2, 0, CANVAS_W - w), y = clamp(pt.y - h/2, 0, CANVAS_H - h);
      const id = createObject({ type: 'text', x, y, w, h, html: '<div><br></div>',
        color: currentColor, fontFamily: currentFontFamily, fontPx: currentFontSize,
        bold: currentBold, italic: currentItalic });
      selectObject(id);
      setToolQuiet('select');
      requestAnimationFrame(()=> startEditingText(id));
      return;
    }
    if(currentTool === 'symbol'){
      const size = 64;
      const x = clamp(pt.x - size/2, 0, CANVAS_W - size), y = clamp(pt.y - size/2, 0, CANVAS_H - size);
      createObject({ type: 'text', x, y, w: size, h: size, html: `<div style="text-align:center;">${esc(currentSymbol)}</div>`,
        color: currentColor, fontFamily: FONT_FAMILIES[0].value, fontPx: 40, bold: false, italic: false });
      return;
    }
  }

  function onCanvasPointerMove(e){
    const pt = canvasPoint(e);
    broadcastCursor(pt);
    if(!drawState) return;
    if(drawState.kind === 'pen'){
      drawState.points.push(pt);
      drawPreviewPath(drawState.points);
    }else if(SHAPE_TOOLS.includes(drawState.kind)){
      drawState.end = pt;
      drawPreviewShape(drawState.kind, drawState.start, drawState.end);
    }
  }

  function onCanvasPointerUp(e){
    if(!drawState){ return; }
    if(drawState.kind === 'pen'){
      commitPenStroke(drawState.points);
    }else if(SHAPE_TOOLS.includes(drawState.kind)){
      commitShape(drawState.kind, drawState.start, drawState.end);
    }
    drawState = null;
    previewLayerEl.innerHTML = '';
  }

  function drawPreviewPath(points){
    const d = points.map((p,i)=> `${i===0?'M':'L'}${p.x},${p.y}`).join(' ');
    previewLayerEl.innerHTML = `<path d="${d}" fill="none" stroke="${esc(currentColor)}" stroke-width="${currentSize}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  function drawPreviewShape(tool, start, end){
    const fake = { shapeType: tool, color: currentColor, size: currentSize, flipX: end.x < start.x, flipY: end.y < start.y };
    const x = Math.min(start.x,end.x), y = Math.min(start.y,end.y);
    const w = Math.max(Math.abs(end.x-start.x), 1), h = Math.max(Math.abs(end.y-start.y), 1);
    const box = document.createElement('div');
    box.innerHTML = shapeSvg(fake);
    const svg = box.firstChild;
    svg.setAttribute('x', x); svg.setAttribute('y', y); svg.setAttribute('width', w); svg.setAttribute('height', h);
    previewLayerEl.innerHTML = '';
    previewLayerEl.appendChild(svg);
  }

  function commitPenStroke(points){
    if(points.length < 2) return;
    const xs = points.map(p=> p.x), ys = points.map(p=> p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    const w = Math.max(Math.max(...xs) - x, MIN_OBJ), h = Math.max(Math.max(...ys) - y, MIN_OBJ);
    const norm = points.map(p=> ({ x: (p.x - x) / w, y: (p.y - y) / h }));
    createObject({ type: 'path', x, y, w, h, points: norm, color: currentColor, size: currentSize });
  }

  function commitShape(tool, start, end){
    const x = Math.min(start.x,end.x), y = Math.min(start.y,end.y);
    const w = Math.max(Math.abs(end.x-start.x), MIN_OBJ), h = Math.max(Math.abs(end.y-start.y), MIN_OBJ);
    const id = createObject({ type: 'shape', shapeType: tool, x, y, w, h, color: currentColor, size: currentSize,
      flipX: end.x < start.x, flipY: end.y < start.y });
    selectObject(id);
    setToolQuiet('select');
  }

  function setToolQuiet(tool){
    currentTool = tool;
    const editor = wrapEl && wrapEl.closest('.wb-editor');
    if(editor) syncToolButtons(editor);
  }

  /* ---- moving / resizing an existing object ---- */
  function onObjectPointerDown(e, id){
    if(currentTool === 'eraser'){ removeObject(id); return; }
    if(currentTool !== 'select') return;
    e.stopPropagation();
    if(editingId && editingId !== id) stopEditingText(editingId);
    selectObject(id);
    const handle = e.target.dataset.h;
    const obj = objectCache[id];
    const startPt = canvasPoint(e);
    dragState = {
      id, mode: handle ? 'resize' : 'move', handle,
      startPt, orig: { x: obj.x, y: obj.y, w: obj.w, h: obj.h }
    };
    const node = objectEls[id];
    node.setPointerCapture(e.pointerId);
    node.addEventListener('pointermove', onObjectPointerMove);
    node.addEventListener('pointerup', onObjectPointerUp);
    node.addEventListener('pointercancel', onObjectPointerUp);
  }

  function onObjectPointerMove(e){
    if(!dragState) return;
    e.stopPropagation();
    const pt = canvasPoint(e);
    const dx = pt.x - dragState.startPt.x, dy = pt.y - dragState.startPt.y;
    const o = dragState.orig;
    let next;
    if(dragState.mode === 'move'){
      next = {
        x: clamp(o.x + dx, 0, CANVAS_W - o.w),
        y: clamp(o.y + dy, 0, CANVAS_H - o.h)
      };
    }else{
      next = resizeFromHandle(o, dragState.handle, dx, dy);
    }
    patchObject(dragState.id, next, { skipRemote: true });
    const node = objectEls[dragState.id];
    positionObjectNode(node, objectCache[dragState.id]);
    if(objectCache[dragState.id].type === 'path' || objectCache[dragState.id].type === 'shape'){
      // re-render so non-uniform scaling of the SVG box looks right immediately
      refreshObjectContent(node, objectCache[dragState.id]);
    }
  }

  function resizeFromHandle(o, handle, dx, dy){
    let x = o.x, y = o.y, w = o.w, h = o.h;
    if(handle.includes('e')) w = clamp(o.w + dx, MIN_OBJ, CANVAS_W - o.x);
    if(handle.includes('s')) h = clamp(o.h + dy, MIN_OBJ, CANVAS_H - o.y);
    if(handle.includes('w')){
      const newW = clamp(o.w - dx, MIN_OBJ, o.x + o.w);
      x = o.x + (o.w - newW); w = newW;
    }
    if(handle.includes('n')){
      const newH = clamp(o.h - dy, MIN_OBJ, o.y + o.h);
      y = o.y + (o.h - newH); h = newH;
    }
    return { x, y, w, h };
  }

  function onObjectPointerUp(e){
    if(!dragState) return;
    const node = objectEls[dragState.id];
    if(node){
      node.removeEventListener('pointermove', onObjectPointerMove);
      node.removeEventListener('pointerup', onObjectPointerUp);
      node.removeEventListener('pointercancel', onObjectPointerUp);
    }
    const obj = objectCache[dragState.id];
    if(obj){
      writeWithRetry(()=> objectsCol(activeBoardId).doc(dragState.id).update({
        x: obj.x, y: obj.y, w: obj.w, h: obj.h, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      })).catch(reportWriteError);
    }
    dragState = null;
  }

  /* --------------------------- images --------------------------- */
  function handleImageFile(file){
    const reader = new FileReader();
    reader.onload = ()=>{
      const img = new Image();
      img.onload = ()=>{
        const scale = Math.min(1, IMAGE_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
        const pxW = Math.round(img.naturalWidth * scale), pxH = Math.round(img.naturalHeight * scale);
        const c = document.createElement('canvas'); c.width = pxW; c.height = pxH;
        c.getContext('2d').drawImage(img, 0, 0, pxW, pxH);
        let quality = 0.85, dataUrl = c.toDataURL('image/jpeg', quality);
        while(dataUrl.length > IMAGE_MAX_BYTES && quality > 0.35){
          quality -= 0.1;
          dataUrl = c.toDataURL('image/jpeg', quality);
        }
        if(dataUrl.length > IMAGE_MAX_BYTES){
          alert('That image is too large even after compressing. Try a smaller photo or a screenshot instead.');
          return;
        }
        const aspect = pxH / pxW;
        const w = clamp(Math.min(560, CANVAS_W * 0.5), MIN_OBJ, CANVAS_W);
        const h = clamp(w * aspect, MIN_OBJ, CANVAS_H);
        const x = (CANVAS_W - w) / 2, y = (CANVAS_H - h) / 2;
        const id = createObject({ type: 'image', x, y, w, h, src: dataUrl });
        selectObject(id);
        setToolQuiet('select');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  /* --------------------------- export --------------------------- */
  function exportBoardAsPng(titleEl){
    if(!activeBoardId) return;
    const out = document.createElement('canvas');
    out.width = CANVAS_W; out.height = CANVAS_H;
    const octx = out.getContext('2d');
    octx.fillStyle = '#FFFFFF'; octx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    const ordered = Object.values(objectCache).sort((a,b)=> (a.zIndex||0) - (b.zIndex||0));
    const imageLoads = [];
    ordered.forEach(obj=>{
      if(obj.type === 'path'){
        if(!obj.points || obj.points.length < 2) return;
        octx.save();
        octx.strokeStyle = obj.color || '#1F3A2E'; octx.lineWidth = obj.size || 5;
        octx.lineCap = 'round'; octx.lineJoin = 'round';
        octx.beginPath();
        obj.points.forEach((p,i)=>{
          const px = obj.x + p.x*obj.w, py = obj.y + p.y*obj.h;
          if(i===0) octx.moveTo(px,py); else octx.lineTo(px,py);
        });
        octx.stroke(); octx.restore();
      }else if(obj.type === 'shape'){
        drawShapeToCanvas(octx, obj);
      }else if(obj.type === 'text'){
        drawTextToCanvas(octx, obj);
      }else if(obj.type === 'image'){
        imageLoads.push(new Promise(res=>{
          const im = new Image();
          im.onload = ()=>{ octx.drawImage(im, obj.x, obj.y, obj.w, obj.h); res(); };
          im.onerror = ()=> res();
          im.src = obj.src;
        }));
      }
    });
    Promise.all(imageLoads).then(()=>{
      const rawTitle = (titleEl && titleEl.textContent) ? titleEl.textContent.trim() : 'whiteboard';
      const safeName = rawTitle.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'whiteboard';
      const link = document.createElement('a');
      link.href = out.toDataURL('image/png');
      link.download = `${safeName}.png`;
      document.body.appendChild(link); link.click(); link.remove();
    });
  }

  function drawShapeToCanvas(octx, obj){
    const x1 = obj.x + (obj.flipX ? obj.w : 0), x2 = obj.x + (obj.flipX ? 0 : obj.w);
    const y1 = obj.y + (obj.flipY ? obj.h : 0), y2 = obj.y + (obj.flipY ? 0 : obj.h);
    octx.save();
    octx.strokeStyle = obj.color || '#1F3A2E'; octx.fillStyle = obj.color || '#1F3A2E';
    octx.lineWidth = obj.size || 5; octx.lineCap = 'round'; octx.lineJoin = 'round';
    if(obj.shapeType === 'line'){
      octx.beginPath(); octx.moveTo(x1,y1); octx.lineTo(x2,y2); octx.stroke();
    }else if(obj.shapeType === 'arrow'){
      const angle = Math.atan2(y2-y1, x2-x1); const headLen = Math.max(14, (obj.size||5)*3.2);
      octx.beginPath(); octx.moveTo(x1,y1); octx.lineTo(x2,y2); octx.stroke();
      octx.beginPath(); octx.moveTo(x2,y2);
      octx.lineTo(x2 - headLen*Math.cos(angle-Math.PI/7), y2 - headLen*Math.sin(angle-Math.PI/7));
      octx.lineTo(x2 - headLen*Math.cos(angle+Math.PI/7), y2 - headLen*Math.sin(angle+Math.PI/7));
      octx.closePath(); octx.fill();
    }else if(obj.shapeType === 'rect'){
      octx.strokeRect(obj.x, obj.y, obj.w, obj.h);
    }else if(obj.shapeType === 'circle'){
      octx.beginPath(); octx.ellipse(obj.x+obj.w/2, obj.y+obj.h/2, obj.w/2, obj.h/2, 0, 0, Math.PI*2); octx.stroke();
    }else if(obj.shapeType === 'triangle'){
      octx.beginPath();
      octx.moveTo(obj.x+obj.w/2, obj.y); octx.lineTo(obj.x+obj.w, obj.y+obj.h); octx.lineTo(obj.x, obj.y+obj.h);
      octx.closePath(); octx.stroke();
    }
    octx.restore();
  }

  // Text is exported line-by-line from the sanitized HTML's plain structure;
  // nested <ul>/<ol> are rasterized as "\u2022 " / "1. " prefixed lines. This
  // is a reasonable flattening, not a pixel-perfect re-layout of the box.
  function drawTextToCanvas(octx, obj){
    const tmp = document.createElement('div');
    tmp.innerHTML = obj.html || '';
    const lines = [];
    let counters = [];
    (function walk(node, depth){
      node.childNodes.forEach(child=>{
        if(child.nodeType === 3){
          const t = child.textContent.trim();
          if(t) lines.push(t);
        }else if(child.nodeType === 1){
          if(child.tagName === 'LI'){
            const ordered = child.parentElement && child.parentElement.tagName === 'OL';
            counters[depth] = (counters[depth]||0) + 1;
            const prefix = ordered ? `${counters[depth]}. ` : '\u2022 ';
            lines.push(prefix + child.textContent.trim());
          }else if(child.tagName === 'UL' || child.tagName === 'OL'){
            counters[depth+1] = 0;
            walk(child, depth+1);
          }else if(child.tagName === 'BR'){
            lines.push('');
          }else{
            walk(child, depth);
          }
        }
      });
    })(tmp, 0);
    octx.save();
    octx.fillStyle = obj.color || '#1F3A2E';
    const weight = obj.bold ? '700' : '600';
    const style = obj.italic ? 'italic' : 'normal';
    const fontPx = obj.fontPx || 24;
    octx.font = `${style} ${weight} ${fontPx}px ${obj.fontFamily || FONT_FAMILIES[0].value}`;
    octx.textBaseline = 'top';
    lines.forEach((line, i)=>{
      octx.fillText(line, obj.x + 6, obj.y + 4 + i * fontPx * 1.3, obj.w - 12);
    });
    octx.restore();
  }

  /* --------------------------- live cursor presence --------------------------- */
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
        if(change.doc.id === ctx.myId) return;
        if(change.type === 'removed'){ delete cursorCache[change.doc.id]; return; }
        cursorCache[change.doc.id] = { id: change.doc.id, ...change.doc.data({ serverTimestamps: 'estimate' }) };
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
    if(unsubObjects){ unsubObjects(); unsubObjects = null; }
    if(unsubCursors){ unsubCursors(); unsubCursors = null; }
    if(cursorSweepTimer){ clearInterval(cursorSweepTimer); cursorSweepTimer = null; }
    if(keydownHandler){ document.removeEventListener('keydown', keydownHandler); keydownHandler = null; }
    if(symbolPanelOutsideHandler){ document.removeEventListener('click', symbolPanelOutsideHandler); symbolPanelOutsideHandler = null; }
    clearMyCursor();
    activeBoardId = null;
    objectCache = {}; objectEls = {}; cursorCache = {}; cursorEls = {};
    selectedId = null; editingId = null; dragState = null; drawState = null;
    myCreateStack = [];
    objLayerEl = previewLayerEl = cursorLayerEl = wrapEl = null;
    undoBtn = deleteBtn = frontBtn = fileInputEl = null;
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