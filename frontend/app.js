/**
 * app.js — Polyglot Memory Visualizer
 *
 * Layout: side-by-side editor | visualizer (no modal).
 * Features: Monaco line highlighting, per-step stdout strip,
 *           icon-only toolbar, compile = compile+run combined,
 *           keyboard shortcuts (Ctrl+Enter compile, ←/→ step).
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   0. SECURITY
   ═══════════════════════════════════════════════════════════════ */
function escapeHTML(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

/* ═══════════════════════════════════════════════════════════════
   1. CONSTANTS & CONFIG
   ═══════════════════════════════════════════════════════════════ */
const API_ENDPOINT   = 'https://memory-visualizer.onrender.com/execute';
const HEALTH_URL     = 'https://memory-visualizer.onrender.com/health';
const HEALTH_PING_MS = 5 * 60_000;
const MAX_STEPS      = 500;
const AUTO_PLAY_MS   = 600;

const MONACO_LANG_MAP = { java: 'java', python: 'python', cpp: 'cpp', javascript: 'javascript' };
const LANG_LABELS     = { java: 'Java', python: 'Python', javascript: 'JavaScript', cpp: 'C++' };

const DEFAULT_CODES = {
    java: `class Node {\n    int val;\n    Node next;\n    Node(int v) { val = v; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        Node head = new Node(1);\n        head.next = new Node(2);\n        head.next.next = new Node(3);\n        Node cur = head;\n        while (cur != null) {\n            System.out.println(cur.val);\n            cur = cur.next;\n        }\n    }\n}`,
    python: `def fibonacci(n):\n    a, b = 0, 1\n    result = []\n    for _ in range(n):\n        result.append(a)\n        a, b = b, a + b\n    return result\n\ndef main():\n    data = {"series": fibonacci(5), "label": "fib"}\n    print("Result:", data)\n\nif __name__ == "__main__":\n    main()`,
    javascript: `function factorial(n) {\n    if (n <= 1) return 1;\n    return n * factorial(n - 1);\n}\n\nfunction main() {\n    const results = [];\n    for (let i = 1; i <= 5; i++) {\n        results.push({ n: i, fact: factorial(i) });\n    }\n    console.log("Factorials:", results);\n}\nmain();`,
    cpp: `#include <iostream>\n#include <vector>\n#include <string>\nusing namespace std;\n\nint sumArray(vector<int>& arr) {\n    int total = 0;\n    for (int x : arr) total += x;\n    return total;\n}\n\nint main() {\n    vector<int> nums = {10, 20, 30, 40, 50};\n    string label = "Sum";\n    int result = sumArray(nums);\n    cout << label << ": " << result << endl;\n    return 0;\n}`
};

/* ═══════════════════════════════════════════════════════════════
   2. STATE
   ═══════════════════════════════════════════════════════════════ */
let editor           = null;
let currentLang      = 'java';
let executionSteps   = [];
let currentStepIndex = 0;
let runtimeError     = null;
let isPlaying        = false;
let playTimer        = null;
let arrowCleanup     = [];
let currentDecorations = [];          // Monaco line-highlight decorations
const collapsedHeapObjects = new Set();

/* ═══════════════════════════════════════════════════════════════
   3. DOM REFERENCES
   ═══════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const elBtnCompile      = $('btn-compile');
const elCompileLoader   = $('compile-loader');
const elColdNotice      = $('cold-start-notice');
const elConsoleOut      = $('console-output');
const elThemeToggle     = $('theme-toggle');
const elServerStatus    = $('server-status');
const elStatusText      = elServerStatus.querySelector('.status-text');

// Toolbar step controls
const elBtnPrev         = $('btn-prev');
const elBtnNext         = $('btn-next');
const elBtnPlay         = $('btn-play');
const elStepCounter     = $('step-counter');
const elProgressFill    = $('step-progress-fill');
const elCurrentLineNum  = $('current-line-num');
const elStdoutPreview   = $('step-stdout-preview');
const elStepsInfo       = $('stat-steps-info');

// Visualization area
const elVizEmptyState   = $('viz-empty-state');
const elMemoryGrid      = $('memory-grid');
const elStackContainer  = $('stack-container');
const elHeapContainer   = $('heap-container');
const elArrowSVG        = $('arrow-svg');
const elVizStdout       = $('viz-stdout-content');

// Language / misc
const elCurrentLangBadge = $('current-lang-badge');
const elModalLangTag     = $('viz-lang-tag');
const elLangBtns         = document.querySelectorAll('.lang-btn');
const elDocSections      = document.querySelectorAll('.lang-docs');

/* ═══════════════════════════════════════════════════════════════
   4. THEME
   ═══════════════════════════════════════════════════════════════ */
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('mem-vis-theme', theme);
    if (editor) monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
}

function initTheme() {
    applyTheme(localStorage.getItem('mem-vis-theme') || 'dark');
}

elThemeToggle.addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

/* ═══════════════════════════════════════════════════════════════
   5. MONACO EDITOR
   ═══════════════════════════════════════════════════════════════ */
function initMonaco() {
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.36.1/min/vs' } });
    require(['vs/editor/editor.main'], () => {
        const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';
        editor = monaco.editor.create($('editor-container'), {
            value: DEFAULT_CODES[currentLang],
            language: MONACO_LANG_MAP[currentLang],
            theme,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontLigatures: true,
            lineHeight: 22,
            padding: { top: 14, bottom: 14 },
            scrollBeyondLastLine: false,
            renderLineHighlight: 'gutter',
            overviewRulerBorder: false,
            glyphMargin: true,
            scrollbar: { verticalScrollbarSize: 5, horizontalScrollbarSize: 5 },
        });

        // Smart Lock: invalidate trace when code is edited
        editor.onDidChangeModelContent(() => {
            if (executionSteps.length > 0) {
                clearEditorHighlight();
                disableStepControls();
                setConsole('Code modified — recompile to update the trace.');
                showEmptyState('Code modified — recompile to update');
                executionSteps = [];
                runtimeError   = null;
            }
        });

        // Ctrl+Enter to compile
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
            elBtnCompile.click();
        });
    });
}

/* ── Editor line highlight ─────────────────────────────────────── */
function highlightEditorLine(lineNum) {
    if (!editor || !lineNum || lineNum < 1) return;
    currentDecorations = editor.deltaDecorations(currentDecorations, [{
        range: new monaco.Range(lineNum, 1, lineNum, 1),
        options: {
            isWholeLine: true,
            className: 'current-exec-line',
            glyphMarginClassName: 'current-exec-glyph',
        },
    }]);
    editor.revealLineInCenterIfOutsideViewport(lineNum);
}

function clearEditorHighlight() {
    if (!editor) return;
    currentDecorations = editor.deltaDecorations(currentDecorations, []);
}

/* ═══════════════════════════════════════════════════════════════
   6. LANGUAGE SWITCHER
   ═══════════════════════════════════════════════════════════════ */
elLangBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const lang = btn.getAttribute('data-lang');
        if (lang === currentLang) return;

        elLangBtns.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        currentLang = lang;

        if (editor) {
            monaco.editor.setModelLanguage(editor.getModel(), MONACO_LANG_MAP[lang]);
            editor.setValue(DEFAULT_CODES[lang]);
        }

        elDocSections.forEach(sec => sec.classList.toggle('active', sec.id === `docs-${lang}`));

        const label = LANG_LABELS[lang] || lang;
        elCurrentLangBadge.textContent = label;
        elModalLangTag.textContent = label;

        resetViz();
        setConsole(`Ready to trace ${label}. Click ⚡ to compile.`);
        clearEditorHighlight();
    });
});

/* ═══════════════════════════════════════════════════════════════
   7. VISUALIZER STATE HELPERS
   ═══════════════════════════════════════════════════════════════ */
function showEmptyState(msg) {
    elVizEmptyState.querySelector('.empty-msg').textContent = msg || 'Compile to start visualizing';
    elVizEmptyState.classList.remove('hidden');
    elMemoryGrid.classList.add('hidden');
}

function showMemoryGrid() {
    elVizEmptyState.classList.add('hidden');
    elMemoryGrid.classList.remove('hidden');
}

function resetViz() {
    executionSteps   = [];
    runtimeError     = null;
    currentStepIndex = 0;
    stopAutoPlay();
    disableStepControls();
    showEmptyState();
    elStepsInfo.textContent = '— steps';
    elCurrentLineNum.textContent = '—';
    elStdoutPreview.textContent  = '';
    elVizStdout.textContent      = '(no output)';
    elStepCounter.textContent    = '—';
    elProgressFill.style.width   = '0%';
    clearEditorHighlight();
}

function enableStepControls() {
    elBtnPrev.disabled = false;
    elBtnNext.disabled = false;
    elBtnPlay.disabled = false;
}

function disableStepControls() {
    elBtnPrev.disabled = true;
    elBtnNext.disabled = true;
    elBtnPlay.disabled = true;
}

/* ═══════════════════════════════════════════════════════════════
   8. SERVER STATUS
   ═══════════════════════════════════════════════════════════════ */
async function checkHealth() {
    try {
        const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(8000) });
        const ok  = res.ok;
        elServerStatus.className = `status-badge ${ok ? 'ok' : 'err'}`;
        elStatusText.textContent = ok ? 'Online' : 'Error';
        return ok;
    } catch {
        elServerStatus.className = 'status-badge err';
        elStatusText.textContent = 'Offline';
        return false;
    }
}

checkHealth();
setInterval(checkHealth, HEALTH_PING_MS);

/* ═══════════════════════════════════════════════════════════════
   9. COMPILE BUTTON  (compile + run combined)
   ═══════════════════════════════════════════════════════════════ */
elBtnCompile.addEventListener('click', async () => {
    if (!editor) return;
    const code = editor.getValue().trim();
    if (!code) { setConsole('[ERROR] Code is empty.'); return; }

    // Loading state
    elBtnCompile.disabled = true;
    elBtnCompile.classList.add('loading');
    disableStepControls();
    showEmptyState('Compiling…');
    setConsole('Compiling and tracing…\n(First request may take 30 s if the server is sleeping.)');
    elColdNotice.classList.add('visible');

    const startTime = Date.now();
    try {
        const ctrl      = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 180_000);

        const response  = await fetch(API_ENDPOINT, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ code, language: currentLang }),
            signal:  ctrl.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);

        const data    = await response.json();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (data.success === false) {
            let msg = `[${data.runtimeError === 'TimeoutError' ? 'TIMEOUT' : data.errors?.length ? 'COMPILE ERROR' : 'ERROR'}] ${data.message || 'Unknown error'}\n`;
            if (data.errors?.length) {
                data.errors.forEach(e => { msg += `  Line ${e.line}: ${e.message}\n`; });
            }
            setConsole(msg);
            showEmptyState('Compilation failed');
            return;
        }

        // Success
        executionSteps   = (data.steps || []).slice(0, MAX_STEPS);
        runtimeError     = data.runtimeError || null;
        currentStepIndex = 0;

        const stepCount = executionSteps.length;
        const finalOut  = stepCount > 0 ? (executionSteps[stepCount - 1].stdout || '') : '';

        let msg = `✅ Compiled in ${elapsed}s — ${stepCount} step${stepCount !== 1 ? 's' : ''} traced.\n`;
        if (finalOut) msg += `\n--- Console Output ---\n${finalOut}`;
        if (runtimeError) msg += `\n\n⚠ Runtime error:\n${runtimeError}`;
        setConsole(msg);

        elStepsInfo.textContent = `${stepCount} steps`;
        elServerStatus.className = 'status-badge ok';
        elStatusText.textContent = 'Online';

        if (stepCount > 0) {
            showMemoryGrid();
            enableStepControls();
            renderStep();
        } else {
            showEmptyState('No steps traced');
        }

    } catch (err) {
        const msg = err.name === 'AbortError'
            ? '[TIMEOUT] Request took too long. Try again — server may be waking up.'
            : `[NETWORK ERROR] ${err.message}`;
        setConsole(msg);
        showEmptyState('Connection error');
    } finally {
        elBtnCompile.disabled = false;
        elBtnCompile.classList.remove('loading');
        elColdNotice.classList.remove('visible');
    }
});

/* ═══════════════════════════════════════════════════════════════
   10. STEP CONTROLS
   ═══════════════════════════════════════════════════════════════ */
elBtnPrev.addEventListener('click', stepPrev);
elBtnNext.addEventListener('click', stepNext);
elBtnPlay.addEventListener('click', toggleAutoPlay);

function stepPrev() { if (currentStepIndex > 0) { currentStepIndex--; renderStep(); } }
function stepNext() { if (currentStepIndex < executionSteps.length - 1) { currentStepIndex++; renderStep(); } }

document.addEventListener('keydown', e => {
    // Don't fire when editor or an input has focus
    if (editor && editor.hasTextFocus()) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); stepNext(); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); stepPrev(); }
});

/* ── Auto-play ─────────────────────────────────────────────────── */
function toggleAutoPlay() { isPlaying ? stopAutoPlay() : startAutoPlay(); }

function startAutoPlay() {
    if (executionSteps.length === 0) return;
    isPlaying = true;
    elBtnPlay.classList.add('playing');
    elBtnPlay.querySelector('.play-icon').classList.add('hidden');
    elBtnPlay.querySelector('.pause-icon').classList.remove('hidden');
    scheduleNextStep();
}

function stopAutoPlay() {
    isPlaying = false;
    clearTimeout(playTimer);
    elBtnPlay.classList.remove('playing');
    elBtnPlay.querySelector('.play-icon').classList.remove('hidden');
    elBtnPlay.querySelector('.pause-icon').classList.add('hidden');
}

function scheduleNextStep() {
    if (!isPlaying) return;
    if (currentStepIndex >= executionSteps.length - 1) { stopAutoPlay(); return; }
    playTimer = setTimeout(() => { currentStepIndex++; renderStep(); scheduleNextStep(); }, AUTO_PLAY_MS);
}

/* ═══════════════════════════════════════════════════════════════
   11. RENDER STEP
   ═══════════════════════════════════════════════════════════════ */
function renderStep() {
    if (executionSteps.length === 0) return;
    const step = executionSteps[currentStepIndex];

    // Toolbar controls state
    elBtnPrev.disabled = currentStepIndex === 0;
    elBtnNext.disabled = currentStepIndex === executionSteps.length - 1;
    elStepCounter.textContent = `${currentStepIndex + 1} / ${executionSteps.length}`;

    // Progress bar
    const pct = executionSteps.length > 1
        ? (currentStepIndex / (executionSteps.length - 1)) * 100 : 100;
    elProgressFill.style.width = `${pct}%`;

    // Toolbar info
    elCurrentLineNum.textContent = String(step.currentLine || '—');

    // Stdout strip — show accumulated stdout up to this step
    const stepOut = step.stdout || '';
    elVizStdout.textContent = stepOut || '(no output yet)';
    elVizStdout.scrollTop   = elVizStdout.scrollHeight;

    // Stdout preview (last non-empty line)
    const lastLine = stepOut.split('\n').filter(Boolean).pop() || '';
    elStdoutPreview.textContent = lastLine ? `↳ ${lastLine}` : '';

    // Render memory panels
    renderStack(step.stack || {});
    renderHeap(step.heap || {});

    // Double rAF: arrows need the DOM painted first
    requestAnimationFrame(() =>
        requestAnimationFrame(() => drawArrows(step.stack || {}, step.heap || {}))
    );

    // Highlight current line in editor
    highlightEditorLine(step.currentLine);
}

/* ═══════════════════════════════════════════════════════════════
   12. RENDER STACK
   ═══════════════════════════════════════════════════════════════ */
function renderStack(stackData) {
    elStackContainer.innerHTML = '';
    const entries = Object.entries(stackData);

    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:var(--text-muted);font-size:0.8rem;padding:12px;font-family:var(--font-mono);';
        empty.textContent = '(no frames)';
        elStackContainer.appendChild(empty);
        return;
    }

    entries.forEach(([frameName, vars]) => {
        const label = document.createElement('div');
        label.className = 'frame-label';
        label.innerHTML = 'frame: <span class="frame-name"></span>';
        label.querySelector('.frame-name').textContent = frameName;
        elStackContainer.appendChild(label);

        const varEntries = Object.entries(vars || {});
        if (varEntries.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:var(--text-muted);font-size:0.75rem;padding:4px 12px;font-family:var(--font-mono);';
            empty.textContent = '(no locals)';
            elStackContainer.appendChild(empty);
            return;
        }
        varEntries.forEach(([varName, rawVal]) => {
            elStackContainer.appendChild(buildStackRow(frameName, varName, String(rawVal ?? '')));
        });
    });
}

function buildStackRow(frameName, varName, rawVal) {
    const row    = document.createElement('div');
    row.className = 'stack-row';
    const safeId  = `stack-${CSS.escape(frameName + '-' + varName)}`;
    row.id        = safeId;

    const left    = document.createElement('div');
    left.className = 'stack-var-left';

    const isRef   = rawVal.startsWith('ref: ');
    let typeStr   = 'var', valStr = rawVal;

    if (isRef) {
        typeStr = 'ref';
    } else if (rawVal.includes(':')) {
        const idx = rawVal.indexOf(':');
        typeStr   = rawVal.substring(0, idx).trim();
        valStr    = rawVal.substring(idx + 1).trim();
    }

    const typeEl = document.createElement('span');
    typeEl.className   = 'var-type';
    typeEl.textContent = typeStr;

    const nameEl = document.createElement('span');
    nameEl.className   = 'var-name';
    nameEl.textContent = varName;

    left.appendChild(typeEl);
    left.appendChild(nameEl);
    row.appendChild(left);

    if (isRef) {
        const targetId = rawVal.substring(5).trim();
        const chip     = document.createElement('span');
        chip.className = 'var-ref';
        chip.setAttribute('data-target', targetId);
        chip.setAttribute('data-source', safeId);
        chip.textContent = `→ ${targetId.replace(/^(obj_|arr_|box_)/, '')}`;
        row.appendChild(chip);
    } else {
        const valEl = document.createElement('span');
        valEl.className   = 'var-val';
        valEl.textContent = valStr;
        row.appendChild(valEl);
    }
    return row;
}

/* ═══════════════════════════════════════════════════════════════
   13. RENDER HEAP
   ═══════════════════════════════════════════════════════════════ */
function renderHeap(heap = {}) {
    elHeapContainer.innerHTML = '';

    if (!heap || Object.keys(heap).length === 0) {
        const empty = document.createElement('div');
        empty.className   = 'empty-state';
        empty.textContent = 'No heap objects at this step';
        elHeapContainer.appendChild(empty);
        return;
    }

    Object.entries(heap).forEach(([objId, obj]) => {
        const card    = document.createElement('div');
        card.className = 'heap-obj';
        card.id        = `heap-${objId}`;
        if (!collapsedHeapObjects.has(objId)) card.classList.add('expanded');

        const header  = document.createElement('div');
        header.className = 'heap-obj-header';

        const headerLeft = document.createElement('div');
        headerLeft.style.cssText = 'display:flex;align-items:center;gap:7px;overflow:hidden;';

        const chevron = document.createElement('span');
        chevron.className   = 'heap-chevron';
        chevron.textContent = '▶';
        chevron.setAttribute('aria-hidden', 'true');

        const typeEl = document.createElement('span');
        typeEl.className   = 'heap-obj-type';
        typeEl.textContent = obj?.type || 'Object';

        headerLeft.appendChild(chevron);
        headerLeft.appendChild(typeEl);

        const idEl = document.createElement('span');
        idEl.className   = 'heap-obj-id';
        idEl.textContent = `@${objId.replace('obj_', '')}`;

        header.appendChild(headerLeft);
        header.appendChild(idEl);
        header.addEventListener('click', () => {
            collapsedHeapObjects.has(objId) ? collapsedHeapObjects.delete(objId) : collapsedHeapObjects.add(objId);
            renderStep();
        });
        card.appendChild(header);

        const body   = document.createElement('div');
        body.className = 'heap-obj-body';

        const fields = Object.entries(obj?.fields || {});
        if (fields.length === 0) {
            body.appendChild(buildHeapField('value', obj?.value ?? 'empty'));
        } else {
            fields.forEach(([key, val]) => body.appendChild(buildHeapField(key, val)));
        }

        card.appendChild(body);
        elHeapContainer.appendChild(card);
    });
}

function buildHeapField(key, val) {
    const row  = document.createElement('div');
    row.className = 'heap-field';

    const keyEl = document.createElement('div');
    keyEl.className   = 'heap-field-key';
    keyEl.textContent = key;

    const isRef = String(val).startsWith('ref: ');
    const valEl = document.createElement('div');
    valEl.className   = `heap-field-val${isRef ? ' is-ref' : ''}`;
    valEl.textContent = isRef ? `→ ${val.substring(5).replace(/^(obj_|arr_|box_)/, '')}` : val;

    row.appendChild(keyEl);
    row.appendChild(valEl);
    return row;
}

/* ═══════════════════════════════════════════════════════════════
   14. DRAW ARROWS
   ═══════════════════════════════════════════════════════════════ */
function drawArrows(stackData, heapData) {
    elArrowSVG.querySelectorAll('path.arrow-path').forEach(p => p.remove());
    arrowCleanup.forEach(fn => fn());
    arrowCleanup = [];

    const refChips = elStackContainer.querySelectorAll('.var-ref');
    if (refChips.length === 0) return;

    const gridRect  = elMemoryGrid.getBoundingClientRect();
    const stackRect = elStackContainer.getBoundingClientRect();
    const heapRect  = elHeapContainer.getBoundingClientRect();

    refChips.forEach(chip => {
        const targetObjId = chip.getAttribute('data-target');
        const sourceRowId = chip.getAttribute('data-source');
        const targetEl    = document.getElementById(`heap-${CSS.escape(targetObjId)}`);
        const sourceRowEl = document.getElementById(sourceRowId);
        if (!targetEl || !sourceRowEl) return;

        const chipRect   = chip.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();

        if (chipRect.bottom < stackRect.top  || chipRect.top > stackRect.bottom) return;
        if (targetRect.bottom < heapRect.top || targetRect.top > heapRect.bottom) return;

        const sx = chipRect.right  - gridRect.left;
        const sy = chipRect.top    + chipRect.height / 2 - gridRect.top;
        const ex = targetRect.left - gridRect.left;
        const ey = targetRect.top  + targetRect.height / 2 - gridRect.top;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'arrow-path');
        path.setAttribute('d', `M${sx},${sy} C${sx + 80},${sy} ${ex - 80},${ey} ${ex},${ey}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'var(--arrow-color)');
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('marker-end', 'url(#arrowhead)');
        path.setAttribute('stroke-linecap', 'round');
        elArrowSVG.appendChild(path);

        const highlight = () => {
            path.setAttribute('stroke', 'var(--accent)');
            path.setAttribute('stroke-width', '2.5');
            path.setAttribute('marker-end', 'url(#arrowhead-active)');
            sourceRowEl.classList.add('highlighted');
            targetEl.classList.add('highlighted');
        };
        const unhighlight = () => {
            path.setAttribute('stroke', 'var(--arrow-color)');
            path.setAttribute('stroke-width', '1.5');
            path.setAttribute('marker-end', 'url(#arrowhead)');
            sourceRowEl.classList.remove('highlighted');
            targetEl.classList.remove('highlighted');
        };

        chip.addEventListener('mouseenter', highlight);
        chip.addEventListener('mouseleave', unhighlight);
        targetEl.addEventListener('mouseenter', highlight);
        targetEl.addEventListener('mouseleave', unhighlight);

        arrowCleanup.push(() => {
            chip.removeEventListener('mouseenter', highlight);
            chip.removeEventListener('mouseleave', unhighlight);
            targetEl.removeEventListener('mouseenter', highlight);
            targetEl.removeEventListener('mouseleave', unhighlight);
        });
    });
}

// Redraw arrows on scroll / resize
const redrawArrows = () => {
    if (executionSteps.length === 0) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const step = executionSteps[currentStepIndex];
        if (step) drawArrows(step.stack || {}, step.heap || {});
    }));
};

elStackContainer.addEventListener('scroll', redrawArrows);
elHeapContainer.addEventListener('scroll', redrawArrows);
window.addEventListener('resize', redrawArrows);

/* ═══════════════════════════════════════════════════════════════
   15. UI HELPERS
   ═══════════════════════════════════════════════════════════════ */
function setConsole(text) {
    elConsoleOut.textContent = text;
}

/* ═══════════════════════════════════════════════════════════════
   16. CANVAS BACKGROUND
   ═══════════════════════════════════════════════════════════════ */
(function initCanvas() {
    const canvas = $('bg-canvas');
    const ctx    = canvas.getContext('2d');
    let W, H, particles = [];
    const MAX_DIST = 140, NUM_PARTICLES = 55;

    function getColors() {
        const dark = document.documentElement.getAttribute('data-theme') !== 'light';
        return {
            dot:  dark ? 'rgba(108,142,247,0.45)' : 'rgba(65,102,212,0.3)',
            line: dark ? 'rgba(108,142,247,' : 'rgba(65,102,212,'
        };
    }

    function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }

    function initParticles() {
        particles = Array.from({ length: NUM_PARTICLES }, () => ({
            x: Math.random() * W, y: Math.random() * H,
            vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
            r: Math.random() * 1.5 + 0.5,
        }));
    }

    function tick() {
        ctx.clearRect(0, 0, W, H);
        const { dot, line } = getColors();
        for (const p of particles) {
            p.x += p.vx; p.y += p.vy;
            if (p.x < 0 || p.x > W) p.vx *= -1;
            if (p.y < 0 || p.y > H) p.vy *= -1;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = dot; ctx.fill();
        }
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
                const dist = Math.hypot(dx, dy);
                if (dist < MAX_DIST) {
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `${line}${(1 - dist / MAX_DIST) * 0.4})`;
                    ctx.lineWidth = 0.8; ctx.stroke();
                }
            }
        }
        requestAnimationFrame(tick);
    }

    window.addEventListener('resize', () => { resize(); initParticles(); });
    resize(); initParticles(); tick();
})();

/* ═══════════════════════════════════════════════════════════════
   17. BOOTSTRAP
   ═══════════════════════════════════════════════════════════════ */
initTheme();
initMonaco();

elCurrentLangBadge.textContent = LANG_LABELS[currentLang];
elModalLangTag.textContent     = LANG_LABELS[currentLang];
elStepsInfo.textContent        = '— steps';
setConsole('Select a language and click ⚡ to compile.');
