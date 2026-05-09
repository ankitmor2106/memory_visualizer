/**
 * app.js — Polyglot Memory Visualizer
 *
 * Security: All backend data is sanitised via escapeHTML() before DOM injection.
 * Arrows: Double-rAF wrapper prevents race conditions on DOM paint.
 * Cold-start: Background /health ping every 5 min keeps Render.com awake.
 * Smart Lock: Modifying the editor disables Run/Visualize until re-compile.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   0. SECURITY — XSS sanitisation
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
// const API_ENDPOINT = 'https://memory-visualizer.onrender.com/execute';
const API_ENDPOINT = 'http://localhost:8080/execute';
const HEALTH_URL     = 'https://memory-visualizer.onrender.com/health';
const GLOBAL_TIMEOUT = 30_000;       // ms — matches backend
const HEALTH_PING_MS = 5 * 60_000;  // 5 minutes
const MAX_STEPS      = 500;
const AUTO_PLAY_MS   = 600;          // ms per auto-play step

const MONACO_LANG_MAP = { java: 'java', python: 'python', cpp: 'cpp', javascript: 'javascript' };

const LANG_LABELS = { java: 'Java', python: 'Python', javascript: 'JavaScript', cpp: 'C++' };

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
let fullStdout       = '';
let runtimeError     = null;
let isPlaying        = false;
let playTimer        = null;
let arrowCleanup     = [];   // cleanup fns for mouseover listeners


/* ═══════════════════════════════════════════════════════════════
   3. DOM REFERENCES
   ═══════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
const heapContainer = document.getElementById("heap-container");
// Track objects the user has explicitly COLLAPSED (everything else stays open)
const collapsedHeapObjects = new Set();

const elBtnCompile       = $('btn-compile');
const elCompileText      = $('compile-btn-text');
const elCompileLoader    = $('compile-loader');
const elColdNotice       = $('cold-start-notice');
const elBtnRun           = $('btn-run');
const elBtnVisualize     = $('btn-visualize');
const elConsoleOut       = $('console-output');
const elThemeToggle      = $('theme-toggle');
const elServerStatus     = $('server-status');
const elStatusText       = elServerStatus.querySelector('.status-text');

const elModal            = $('visualizer-modal');
const elBtnCloseModal    = $('btn-close-modal');
const elBtnPrev          = $('btn-prev');
const elBtnNext          = $('btn-next');
const elBtnPlay          = $('btn-play');
const elStepCounter      = $('step-counter');
const elProgressFill     = $('step-progress-fill');
const elCurrentLineNum   = $('current-line-num');
const elStdoutPreview    = $('step-stdout-preview');
const elStackContainer   = $('stack-container');
const elHeapContainer    = $('heap-container');
const elArrowSVG         = $('arrow-svg');
const elMemoryGrid       = $('memory-grid');
const elModalLangTag     = $('modal-lang-tag');

const elStatSteps        = $('stat-steps');
const elStatLang         = $('stat-lang');
const elStatStatus       = $('stat-status');
const elCurrentLangBadge = $('current-lang-badge');

const elConsolePanel     = $('console-panel');
const elResizeHandle     = $('console-resize-handle');
const elLangBtns         = document.querySelectorAll('.lang-btn');
const elDocSections      = document.querySelectorAll('.lang-docs');

/* ═══════════════════════════════════════════════════════════════
   4. THEME SYSTEM
   ═══════════════════════════════════════════════════════════════ */
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('mem-vis-theme', theme);
    if (editor) {
        monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
    }
}

function initTheme() {
    const saved = localStorage.getItem('mem-vis-theme') || 'dark';
    applyTheme(saved);
}

elThemeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
});

/* ═══════════════════════════════════════════════════════════════
   5. MONACO EDITOR
   ═══════════════════════════════════════════════════════════════ */
function initMonaco() {
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.36.1/min/vs' }});
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
            scrollbar: { verticalScrollbarSize: 5, horizontalScrollbarSize: 5 }
        });

        // Smart Lock: invalidate trace when code is edited
        editor.onDidChangeModelContent(() => {
            if (!elBtnRun.disabled) {
                elBtnRun.disabled = true;
                elBtnVisualize.disabled = true;
                setConsole('Code modified — please re-compile to update the trace.');
                setStats({ status: 'stale' });
            }
        });
    });
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

        // Swap editor content & language
        if (editor) {
            monaco.editor.setModelLanguage(editor.getModel(), MONACO_LANG_MAP[lang]);
            editor.setValue(DEFAULT_CODES[lang]);
        }

        // Swap docs
        elDocSections.forEach(sec => {
            sec.classList.toggle('active', sec.id === `docs-${lang}`);
        });

        // Update badge
        const label = LANG_LABELS[lang] || lang;
        elCurrentLangBadge.textContent = label;
        elModalLangTag.textContent = label;

        // Reset UI
        elBtnRun.disabled = true;
        elBtnVisualize.disabled = true;
        executionSteps = [];
        runtimeError = null;
        setConsole(`Ready to trace ${label} code. Click Compile to begin.`);
        setStats({ steps: '—', lang: label, status: 'idle' });
    });
});

/* ═══════════════════════════════════════════════════════════════
   7. CONSOLE RESIZE
   ═══════════════════════════════════════════════════════════════ */
(function initResize() {
    let resizing = false, startY = 0, startH = 0;

    elResizeHandle.addEventListener('mousedown', e => {
        resizing = true;
        startY = e.clientY;
        startH = parseInt(getComputedStyle(elConsolePanel).height, 10);
        elResizeHandle.classList.add('dragging');
        document.body.style.cursor = 'ns-resize';
        e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
        if (!resizing) return;
        const newH = startH + (e.clientY - startY);
        if (newH > 80 && newH < window.innerHeight * 0.7) {
            elConsolePanel.style.height = `${newH}px`;
            if (editor) editor.layout();
        }
    });

    document.addEventListener('mouseup', () => {
        if (resizing) {
            resizing = false;
            elResizeHandle.classList.remove('dragging');
            document.body.style.cursor = '';
        }
    });
})();

/* ═══════════════════════════════════════════════════════════════
   8. SERVER STATUS & COLD-START PING
   ═══════════════════════════════════════════════════════════════ */
async function checkHealth() {
    try {
        const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(8000) });
        const ok = res.ok;
        elServerStatus.className = `status-badge ${ok ? 'ok' : 'err'}`;
        elStatusText.textContent = ok ? 'Online' : 'Error';
        return ok;
    } catch {
        elServerStatus.className = 'status-badge err';
        elStatusText.textContent = 'Offline';
        return false;
    }
}

// Initial health check + keep-alive ping
checkHealth();
setInterval(checkHealth, HEALTH_PING_MS);

/* ═══════════════════════════════════════════════════════════════
   9. COMPILE BUTTON
   ═══════════════════════════════════════════════════════════════ */
elBtnCompile.addEventListener('click', async () => {
    if (!editor) return;
    const code = editor.getValue().trim();
    if (!code) { setConsole('[ERROR] Code is empty.'); return; }

    // Show loading state
    elBtnCompile.disabled = true;
    elBtnCompile.classList.add('loading');
    elBtnRun.disabled = true;
    elBtnVisualize.disabled = true;
    setConsole('Compiling and tracing…\n(First request may take 30+ seconds if the server is sleeping.)');
    elColdNotice.classList.add('visible');
    setStats({ status: 'compiling…' });

    const startTime = Date.now();

    try {
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 60_000);

        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, language: currentLang }),
            signal: ctrl.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Server returned HTTP ${response.status}`);
        }

        const data = await response.json();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (data.success === false) {
            // Pick the right label: timeout, runtime, or compilation
            let errorLabel;
            if (data.runtimeError === 'TimeoutError') {
                errorLabel = '[TIMEOUT]';
            } else if (data.errors && data.errors.length > 0) {
                errorLabel = '[COMPILATION ERROR]';
            } else {
                errorLabel = '[ERROR]';
            }
            let msg = `${errorLabel} ${data.message || 'Unknown error'}\n`;
            if (data.errors && data.errors.length > 0) {
                data.errors.forEach(e => {
                    msg += `  Line ${escapeHTMLText(e.line)}: ${escapeHTMLText(e.message)}\n`;
                });
            }
            setConsole(msg);
            setStats({ status: 'error', steps: '0' });
            return;
        }

        // Success — store globally
        executionSteps = (data.steps || []).slice(0, MAX_STEPS);
        runtimeError   = data.runtimeError || null;
        fullStdout     = executionSteps.length > 0
            ? (executionSteps[executionSteps.length - 1].stdout || '')
            : '';

        const stepCount = executionSteps.length;
        let successMsg = `✅ Compilation & trace successful in ${elapsed}s\n\n`;
        successMsg += `Traced ${stepCount} execution step${stepCount !== 1 ? 's' : ''}.\n`;
        successMsg += `→ Click "Run" to see output\n`;
        successMsg += `→ Click "Visualize" to step through memory`;
        if (runtimeError) {
            successMsg += `\n\n⚠ Runtime error detected:\n${runtimeError}`;
        }
        setConsole(successMsg);

        elBtnRun.disabled = false;
        if (stepCount > 0) elBtnVisualize.disabled = false;

        setStats({ steps: String(stepCount), lang: LANG_LABELS[currentLang], status: 'ok' });

        // Update server status to online since we got a response
        elServerStatus.className = 'status-badge ok';
        elStatusText.textContent = 'Online';

    } catch (err) {
        const msg = err.name === 'AbortError'
            ? '[TIMEOUT] Request took too long. The server may be waking up — try again in a moment.'
            : `[NETWORK ERROR] ${escapeHTMLText(err.message)}`;
        setConsole(msg);
        setStats({ status: 'error' });
    } finally {
        elBtnCompile.disabled = false;
        elBtnCompile.classList.remove('loading');
        elColdNotice.classList.remove('visible');
    }
});

/* ═══════════════════════════════════════════════════════════════
   10. RUN BUTTON
   ═══════════════════════════════════════════════════════════════ */
elBtnRun.addEventListener('click', () => {
    let out = '--- Console Output ---\n';
    out += fullStdout || '(No output generated)';
    if (runtimeError) out += `\n\n⚠ Runtime Exception:\n${runtimeError}`;
    setConsole(out);
});

/* ═══════════════════════════════════════════════════════════════
   11. VISUALIZE BUTTON & MODAL
   ═══════════════════════════════════════════════════════════════ */
elBtnVisualize.addEventListener('click', openModal);
elBtnCloseModal.addEventListener('click', closeModal);

elModal.addEventListener('click', e => {
    if (e.target === elModal) closeModal();
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !elModal.classList.contains('hidden')) closeModal();
    if (e.key === 'ArrowRight' && !elModal.classList.contains('hidden')) stepNext();
    if (e.key === 'ArrowLeft'  && !elModal.classList.contains('hidden')) stepPrev();
});

function openModal() {
    if (executionSteps.length === 0) return;
    elModalLangTag.textContent = LANG_LABELS[currentLang] || currentLang;
    elModal.classList.remove('hidden');
    document.body.classList.add('no-scroll');
    currentStepIndex = 0;
    stopAutoPlay();
    renderStep();
}

function closeModal() {
    elModal.classList.add('hidden');
    document.body.classList.remove('no-scroll');
    stopAutoPlay();
}

elBtnPrev.addEventListener('click', stepPrev);
elBtnNext.addEventListener('click', stepNext);

function stepPrev() {
    if (currentStepIndex > 0) { currentStepIndex--; renderStep(); }
}
function stepNext() {
    if (currentStepIndex < executionSteps.length - 1) { currentStepIndex++; renderStep(); }
}

/* ── Auto-play ─────────────────────────────────────────────────── */
elBtnPlay.addEventListener('click', toggleAutoPlay);

function toggleAutoPlay() {
    isPlaying ? stopAutoPlay() : startAutoPlay();
}

function startAutoPlay() {
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
    playTimer = setTimeout(() => {
        currentStepIndex++;
        renderStep();
        scheduleNextStep();
    }, AUTO_PLAY_MS);
}

/* ═══════════════════════════════════════════════════════════════
   12. RENDER STEP
   ═══════════════════════════════════════════════════════════════ */
function renderStep() {
    if (executionSteps.length === 0) return;
    const step = executionSteps[currentStepIndex];

    // Controls
    elBtnPrev.disabled = currentStepIndex === 0;
    elBtnNext.disabled = currentStepIndex === executionSteps.length - 1;
    elStepCounter.textContent = `${currentStepIndex + 1} / ${executionSteps.length}`;

    // Progress bar
    const pct = executionSteps.length > 1
        ? (currentStepIndex / (executionSteps.length - 1)) * 100
        : 100;
    elProgressFill.style.width = `${pct}%`;

    // Info bar
    elCurrentLineNum.textContent = escapeHTML(String(step.currentLine || '—'));
    const stdoutLastLine = (step.stdout || '').split('\n').filter(Boolean).pop() || '';
    elStdoutPreview.textContent = stdoutLastLine ? `stdout: ${stdoutLastLine}` : '';

    // Render memory
    renderStack(step.stack || {});
    renderHeap(step.heap || {});

    // CRITICAL: double rAF to ensure DOM is painted before drawing arrows
    requestAnimationFrame(() =>
        requestAnimationFrame(() => drawArrows(step.stack || {}, step.heap || {}))
    );
}

/* ═══════════════════════════════════════════════════════════════
   13. RENDER STACK  (XSS-safe — uses textContent everywhere)
   ═══════════════════════════════════════════════════════════════ */
function renderStack(stackData) {
    elStackContainer.innerHTML = '';

    const entries = Object.entries(stackData);
    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color: var(--text-muted); font-size: 0.8rem; padding: 12px; font-family: var(--font-mono);';
        empty.textContent = '(no frames)';
        elStackContainer.appendChild(empty);
        return;
    }

    entries.forEach(([frameName, vars]) => {
        // Frame label
        const label = document.createElement('div');
        label.className = 'frame-label';
        label.innerHTML = 'frame: <span class="frame-name"></span>';
        label.querySelector('.frame-name').textContent = frameName;
        elStackContainer.appendChild(label);

        // Variables
        const varEntries = Object.entries(vars || {});
        if (varEntries.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color: var(--text-muted); font-size: 0.75rem; padding: 4px 12px; font-family: var(--font-mono);';
            empty.textContent = '(no locals)';
            elStackContainer.appendChild(empty);
            return;
        }

        varEntries.forEach(([varName, rawVal]) => {
            const row = buildStackRow(frameName, varName, String(rawVal ?? ''));
            elStackContainer.appendChild(row);
        });
    });
}

function buildStackRow(frameName, varName, rawVal) {
    const row = document.createElement('div');
    row.className = 'stack-row';

    // Safe frame+var id for DOM lookups
    const safeId = `stack-${CSS.escape(frameName + '-' + varName)}`;
    row.id = safeId;

    // Left: type + name
    const left = document.createElement('div');
    left.className = 'stack-var-left';

    const isRef = rawVal.startsWith('ref: ');
    let typeStr = 'var';
    let valStr  = rawVal;

    if (isRef) {
        typeStr = 'ref';
        // valStr remains e.g. "ref: obj_12345"
    } else if (rawVal.includes(':')) {
        const splitIdx = rawVal.indexOf(':');
        typeStr = rawVal.substring(0, splitIdx).trim();
        valStr  = rawVal.substring(splitIdx + 1).trim();
    }

    const typeEl = document.createElement('span');
    typeEl.className = 'var-type';
    typeEl.textContent = typeStr;

    const nameEl = document.createElement('span');
    nameEl.className = 'var-name';
    nameEl.textContent = varName;

    left.appendChild(typeEl);
    left.appendChild(nameEl);
    row.appendChild(left);

    // Right: value or reference chip
    if (isRef) {
        const targetId = rawVal.substring(5).trim();   // "obj_12345"
        const chip = document.createElement('span');
        chip.className = 'var-ref';
        chip.setAttribute('data-target', targetId);
        chip.setAttribute('data-source', safeId);
        // Display a friendly label
        const num = targetId.replace(/^(obj_|arr_|box_)/, '');
        chip.textContent = `→ ${num}`;
        row.appendChild(chip);
    } else {
        const valEl = document.createElement('span');
        valEl.className = 'var-val';
        valEl.textContent = valStr;
        row.appendChild(valEl);
    }

    return row;
}

/* ═══════════════════════════════════════════════════════════════
   14. RENDER HEAP  (card-per-object, uses CSS .heap-obj classes)
   ═══════════════════════════════════════════════════════════════ */
function renderHeap(heap = {}) {
    // Use elHeapContainer (the canonical reference) consistently
    elHeapContainer.innerHTML = '';

    if (!heap || Object.keys(heap).length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No heap objects at this step';
        elHeapContainer.appendChild(empty);
        return;
    }

    Object.entries(heap).forEach(([objId, obj]) => {
        // ── Card ──────────────────────────────────────────────────────
        const card = document.createElement('div');
        card.className = 'heap-obj';          // matches .heap-obj in CSS
        card.id = `heap-${objId}`;            // targeted by drawArrows()

        // Default: expanded unless user explicitly collapsed this object
        if (!collapsedHeapObjects.has(objId)) {
            card.classList.add('expanded');
        }

        // ── Header ────────────────────────────────────────────────────
        const header = document.createElement('div');
        header.className = 'heap-obj-header'; // matches .heap-obj-header in CSS

        const headerLeft = document.createElement('div');
        headerLeft.style.cssText = 'display:flex;align-items:center;gap:7px;overflow:hidden;';

        const chevron = document.createElement('span');
        chevron.className = 'heap-chevron';   // rotates 90° via CSS when .expanded
        chevron.textContent = '▶';
        chevron.setAttribute('aria-hidden', 'true');

        const typeEl = document.createElement('span');
        typeEl.className = 'heap-obj-type';   // matches .heap-obj-type in CSS
        typeEl.textContent = obj?.type || 'Object';

        headerLeft.appendChild(chevron);
        headerLeft.appendChild(typeEl);

        const idEl = document.createElement('span');
        idEl.className = 'heap-obj-id';       // matches .heap-obj-id in CSS
        idEl.textContent = `@${objId.replace('obj_', '')}`;

        header.appendChild(headerLeft);
        header.appendChild(idEl);

        header.addEventListener('click', () => {
            if (collapsedHeapObjects.has(objId)) {
                collapsedHeapObjects.delete(objId);
            } else {
                collapsedHeapObjects.add(objId);
            }
            renderStep();
        });

        card.appendChild(header);

        // ── Body (shown only when .expanded) ──────────────────────────
        const body = document.createElement('div');
        body.className = 'heap-obj-body';     // matches .heap-obj-body in CSS

        const fieldEntries = Object.entries(obj?.fields || {});

        if (fieldEntries.length === 0) {
            // No fields — show the raw value (primitive wrapper, pointer, etc.)
            body.appendChild(buildHeapField('value', obj?.value ?? 'empty'));
        } else {
            fieldEntries.forEach(([key, val]) => {
                body.appendChild(buildHeapField(key, val));
            });
        }

        card.appendChild(body);
        elHeapContainer.appendChild(card);
    });
}

function buildHeapField(key, val) {
    const row = document.createElement('div');
    row.className = 'heap-field';

    const keyEl = document.createElement('div');
    keyEl.className = 'heap-field-key';
    keyEl.textContent = key;

    const valEl = document.createElement('div');
    const isRef = String(val).startsWith('ref: ');
    valEl.className = `heap-field-val${isRef ? ' is-ref' : ''}`;
    valEl.textContent = isRef ? `→ ${val.substring(5).replace(/^(obj_|arr_|box_)/, '')}` : val;

    row.appendChild(keyEl);
    row.appendChild(valEl);
    return row;
}

/* ═══════════════════════════════════════════════════════════════
   15. DRAW ARROWS  (double-rAF guaranteed, coordinate-safe)
   ═══════════════════════════════════════════════════════════════ */
function drawArrows(stackData, heapData) {
    // Remove previous paths
    elArrowSVG.querySelectorAll('path.arrow-path').forEach(p => p.remove());


    // Remove previous event listeners
    arrowCleanup.forEach(fn => fn());
    arrowCleanup = [];

    const refChips = elStackContainer.querySelectorAll('.var-ref');
    if (refChips.length === 0) return;

    const gridRect  = elMemoryGrid.getBoundingClientRect();
    const stackRect = elStackContainer.getBoundingClientRect();
    const heapRect  = elHeapContainer.getBoundingClientRect();

    refChips.forEach(chip => {
        const targetObjId  = chip.getAttribute('data-target');
        const sourceRowId  = chip.getAttribute('data-source');
        const targetEl     = document.getElementById(`heap-${CSS.escape(targetObjId)}`);
        const sourceRowEl  = document.getElementById(sourceRowId);

        if (!targetEl || !sourceRowEl) return;

        const chipRect   = chip.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();

        // Skip if either element is scrolled out of its pane's visible area
        if (chipRect.bottom < stackRect.top  || chipRect.top > stackRect.bottom) return;
        if (targetRect.bottom < heapRect.top || targetRect.top > heapRect.bottom) return;

        // Coordinates relative to memory grid container
        const sx = chipRect.right  - gridRect.left;
        const sy = chipRect.top    + chipRect.height / 2 - gridRect.top;
        const ex = targetRect.left - gridRect.left;
        const ey = targetRect.top  + targetRect.height / 2 - gridRect.top;

        // Bezier control points
        const cp1x = sx + 80;
        const cp2x = ex - 80;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'arrow-path');
        path.setAttribute('d', `M${sx},${sy} C${cp1x},${sy} ${cp2x},${ey} ${ex},${ey}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'var(--arrow-color)');
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('marker-end', 'url(#arrowhead)');
        path.setAttribute('stroke-linecap', 'round');
        elArrowSVG.appendChild(path);

        // Hover highlight
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

// Redraw arrows on scroll or resize
elStackContainer.addEventListener('scroll', () => {
    if (!elModal.classList.contains('hidden')) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const step = executionSteps[currentStepIndex];
            if (step) drawArrows(step.stack || {}, step.heap || {});
        }));
    }
});
elHeapContainer.addEventListener('scroll', () => {
    if (!elModal.classList.contains('hidden')) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const step = executionSteps[currentStepIndex];
            if (step) drawArrows(step.stack || {}, step.heap || {});
        }));
    }
});
window.addEventListener('resize', () => {
    if (!elModal.classList.contains('hidden')) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const step = executionSteps[currentStepIndex];
            if (step) drawArrows(step.stack || {}, step.heap || {});
        }));
    }
});

/* ═══════════════════════════════════════════════════════════════
   16. UI HELPERS
   ═══════════════════════════════════════════════════════════════ */
function setConsole(text) {
    elConsoleOut.textContent = text;
}

function escapeHTMLText(val) {
    return String(val ?? '');   // For use in textContent, no actual escaping needed
}

function setStats({ steps, lang, status } = {}) {
    if (steps !== undefined) elStatSteps.textContent = steps;
    if (lang  !== undefined) elStatLang.textContent  = lang;
    if (status !== undefined) {
        elStatStatus.textContent = status;
        elStatStatus.className = `stat-value ${status === 'ok' ? 'ok' : status === 'error' ? 'err' : ''}`;
    }
}

/* ═══════════════════════════════════════════════════════════════
   17. CANVAS BACKGROUND
   ═══════════════════════════════════════════════════════════════ */
(function initCanvas() {
    const canvas = $('bg-canvas');
    const ctx    = canvas.getContext('2d');
    let W, H, particles = [];

    const MAX_DIST = 140;
    const NUM_PARTICLES = 55;

    function getColors() {
        const dark = document.documentElement.getAttribute('data-theme') !== 'light';
        return {
            dot:  dark ? 'rgba(108,142,247,0.45)' : 'rgba(65,102,212,0.3)',
            line: dark ? 'rgba(108,142,247,' : 'rgba(65,102,212,'
        };
    }

    function resize() {
        W = canvas.width  = window.innerWidth;
        H = canvas.height = window.innerHeight;
    }

    function initParticles() {
        particles = Array.from({ length: NUM_PARTICLES }, () => ({
            x: Math.random() * W,
            y: Math.random() * H,
            vx: (Math.random() - 0.5) * 0.4,
            vy: (Math.random() - 0.5) * 0.4,
            r: Math.random() * 1.5 + 0.5
        }));
    }

    function tick() {
        ctx.clearRect(0, 0, W, H);
        const { dot, line } = getColors();

        for (const p of particles) {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0 || p.x > W) p.vx *= -1;
            if (p.y < 0 || p.y > H) p.vy *= -1;

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = dot;
            ctx.fill();
        }

        // Connect nearby particles
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx   = particles[i].x - particles[j].x;
                const dy   = particles[i].y - particles[j].y;
                const dist = Math.hypot(dx, dy);
                if (dist < MAX_DIST) {
                    const alpha = (1 - dist / MAX_DIST) * 0.4;
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `${line}${alpha})`;
                    ctx.lineWidth   = 0.8;
                    ctx.stroke();
                }
            }
        }

        requestAnimationFrame(tick);
    }

    window.addEventListener('resize', () => { resize(); initParticles(); });
    resize();
    initParticles();
    tick();
})();

/* ═══════════════════════════════════════════════════════════════
   18. BOOTSTRAP
   ═══════════════════════════════════════════════════════════════ */
initTheme();
initMonaco();

// Set initial stats
setStats({ steps: '—', lang: LANG_LABELS[currentLang], status: 'idle' });
elCurrentLangBadge.textContent = LANG_LABELS[currentLang];