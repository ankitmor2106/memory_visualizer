/**
 * app.js — Polyglot Memory Visualizer
 *
 * Two-tab JS mode:
 *   • Memory Trace  — sends code to backend CDP tracer, shows stack/heap
 *   • Browser Run   — runs JS in sandboxed iframe with HTML template editor
 *
 * Stdout strip removed; backend console stays in left panel.
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

/** Default JS shown when switching to Browser Run for the first time */
const DEFAULT_BROWSER_JS = `// This code runs in the browser sandbox.
// It can interact with the HTML template on the left!

const btn    = document.getElementById('btn');
const output = document.getElementById('output');
const list   = document.getElementById('list');
let clicks   = 0;

btn.addEventListener('click', () => {
  clicks++;
  output.textContent = \`Button clicked \${clicks} time\${clicks !== 1 ? 's' : ''}!\`;

  const li = document.createElement('li');
  li.textContent = \`Click #\${clicks} — \${new Date().toLocaleTimeString()}\`;
  list.appendChild(li);

  console.log('click event', clicks);
});

// Run once on load
output.textContent = 'Page ready — click the button above!';
console.log('Script loaded ✔');
`;

/** Default HTML template for the browser run HTML editor */
const DEFAULT_BROWSER_HTML = `<div id="app">
  <h2 id="title">Browser Sandbox</h2>
  <p id="output">Output appears here…</p>
  <button id="btn">Click Me</button>
  <ul id="list"></ul>
</div>

<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: system-ui, sans-serif;
    padding: 18px; margin: 0;
    background: #fff; color: #111;
    font-size: 14px; line-height: 1.5;
  }
  h2   { margin: 0 0 10px; font-size: 1.1rem; font-weight: 700; }
  #output {
    padding: 9px 13px;
    background: #f3f4f6; border-radius: 8px;
    margin-bottom: 12px; min-height: 36px;
    color: #374151; font-size: 0.9rem;
  }
  button {
    padding: 7px 18px; border-radius: 6px;
    border: 1px solid #d1d5db; background: #fff;
    cursor: pointer; font-size: 13px;
    margin-bottom: 12px; transition: background .15s;
  }
  button:hover { background: #f9fafb; }
  ul { margin: 0; padding-left: 18px; }
  li { padding: 3px 0; color: #374151; font-size: 0.85rem; }
</style>`;

/* ═══════════════════════════════════════════════════════════════
   2. STATE
   ═══════════════════════════════════════════════════════════════ */
let editor             = null;
let currentLang        = 'java';
let executionSteps     = [];
let currentStepIndex   = 0;
let runtimeError       = null;
let isPlaying          = false;
let playTimer          = null;
let arrowCleanup       = [];
let currentDecorations = [];
let jsRunMode          = 'trace';   // 'trace' | 'browser'
let browserJsInjected  = false;     // true once we pre-fill browser JS
const collapsedHeapObjects = new Set();

/* ═══════════════════════════════════════════════════════════════
   3. DOM REFERENCES
   ═══════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const elBtnCompile       = $('btn-compile');
const elCompileLoader    = $('compile-loader');
const elColdNotice       = $('cold-start-notice');
const elConsoleOut       = $('console-output');
const elThemeToggle      = $('theme-toggle');
const elServerStatus     = $('server-status');
const elStatusText       = elServerStatus.querySelector('.status-text');
const elConsolePanel     = $('console-panel');

// Toolbar step controls
const elBtnPrev          = $('btn-prev');
const elBtnNext          = $('btn-next');
const elBtnPlay          = $('btn-play');
const elStepCounter      = $('step-counter');
const elProgressFill     = $('step-progress-fill');
const elCurrentLineNum   = $('current-line-num');
const elStepsInfo        = $('stat-steps-info');
const elVizToolbar       = $('viz-toolbar');

// Visualization area
const elVizEmptyState    = $('viz-empty-state');
const elMemoryGrid       = $('memory-grid');
const elStackContainer   = $('stack-container');
const elHeapContainer    = $('heap-container');
const elArrowSVG         = $('arrow-svg');

// Language / misc
const elCurrentLangBadge = $('current-lang-badge');
const elModalLangTag     = $('viz-lang-tag');
const elLangBtns         = document.querySelectorAll('.lang-btn');
const elDocSections      = document.querySelectorAll('.lang-docs');

// ── JS Tab bar ────────────────────────────────────────────────────
const elVizTabBar        = $('viz-tab-bar');
const elTabTrace         = $('tab-trace');
const elTabBrowser       = $('tab-browser');
const elVizTabInk        = $('viz-tab-ink');

// ── Browser Run panel ─────────────────────────────────────────────
const elBrowserRunPanel  = $('browser-run-panel');
const elBrowserIframe    = $('browser-iframe');
const elBrowserConsole   = $('browser-console');
const elBrowserRunBtn    = $('browser-run-btn');
const elBrowserClearBtn  = $('browser-clear-btn');
const elBrowserAddrBar   = $('browser-addr');

// ── HTML template editor ──────────────────────────────────────────
const elHtmlEditorPanel  = $('html-editor-panel');
const elHtmlEditor       = $('html-editor');

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

        // Smart Lock: invalidate trace when code is edited (trace mode only)
        editor.onDidChangeModelContent(() => {
            if (jsRunMode === 'trace' && executionSteps.length > 0) {
                clearEditorHighlight();
                disableStepControls();
                setConsole('Code modified — recompile to update the trace.');
                showEmptyState('Code modified — recompile to update');
                executionSteps = [];
                runtimeError   = null;
            }
        });

        // Ctrl+Enter to compile / run
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

        if (lang === 'javascript') {
            // Show tab bar, default to trace
            elVizTabBar.classList.remove('hidden');
            setJsMode('trace');
        } else {
            // Hide tab bar, reset to trace layout
            elVizTabBar.classList.add('hidden');
            jsRunMode = 'trace';
            elBrowserRunPanel.classList.add('hidden');
            elVizToolbar.classList.remove('hidden');
            elConsolePanel.classList.remove('hidden');
            elHtmlEditorPanel.classList.add('hidden');
        }

        resetViz();
        setConsole(`Ready to trace ${label}. Click ⚡ to compile.`);
        clearEditorHighlight();
    });
});

/* ═══════════════════════════════════════════════════════════════
   6b. JS TAB SYSTEM — Memory Trace ↔ Browser Run
   ═══════════════════════════════════════════════════════════════ */

/** Move the ink underline to whichever tab is active */
function updateTabInk(mode) {
    if (!elVizTabInk || !elTabTrace || !elTabBrowser) return;
    const target = mode === 'trace' ? elTabTrace : elTabBrowser;
    const barRect  = elVizTabBar.getBoundingClientRect();
    const tabRect  = target.getBoundingClientRect();
    elVizTabInk.style.left  = (tabRect.left - barRect.left) + 'px';
    elVizTabInk.style.width = tabRect.width + 'px';
}

/** Switch between memory-trace and browser-run panels */
function setJsMode(mode) {
    jsRunMode = mode;

    elTabTrace.classList.toggle('active',   mode === 'trace');
    elTabBrowser.classList.toggle('active', mode === 'browser');
    elTabTrace.setAttribute('aria-selected',   String(mode === 'trace'));
    elTabBrowser.setAttribute('aria-selected', String(mode === 'browser'));

    // Defer ink so layout is settled
    requestAnimationFrame(() => updateTabInk(mode));

    if (mode === 'browser') {
        // ── Show browser panel, hide trace UI ─────────────────
        elVizToolbar.classList.add('hidden');
        elVizEmptyState.classList.add('hidden');
        elMemoryGrid.classList.add('hidden');
        elBrowserRunPanel.classList.remove('hidden');

        // Left column: swap console → HTML editor
        elConsolePanel.classList.add('hidden');
        elHtmlEditorPanel.classList.remove('hidden');

        // Pre-fill HTML editor default once
        if (elHtmlEditor && !elHtmlEditor.value.trim()) {
            elHtmlEditor.value = DEFAULT_BROWSER_HTML;
        }

        // Pre-fill default browser JS once
        if (!browserJsInjected && editor) {
            editor.setValue(DEFAULT_BROWSER_JS);
            browserJsInjected = true;
        }

        disableStepControls();
        clearEditorHighlight();

    } else {
        // ── Show trace panel, hide browser UI ─────────────────
        elVizToolbar.classList.remove('hidden');
        elBrowserRunPanel.classList.add('hidden');

        // Left column: show console, hide HTML editor
        elConsolePanel.classList.remove('hidden');
        elHtmlEditorPanel.classList.add('hidden');

        if (executionSteps.length > 0) {
            showMemoryGrid();
            enableStepControls();
            renderStep();
        } else {
            showEmptyState('Switch to Memory Trace — compile to visualize');
        }
    }
}

elTabTrace.addEventListener('click',   () => setJsMode('trace'));
elTabBrowser.addEventListener('click', () => setJsMode('browser'));

/* ── Browser run / clear buttons ─────────────────────────────── */
elBrowserRunBtn.addEventListener('click', () => {
    if (!editor) return;
    runInBrowser(editor.getValue().trim(), elHtmlEditor ? elHtmlEditor.value : '');
});

elBrowserClearBtn.addEventListener('click', () => {
    elBrowserConsole.innerHTML = '';
});

/* ═══════════════════════════════════════════════════════════════
   6c. RUN IN BROWSER (sandboxed iframe)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Execute user JS inside a sandboxed iframe that contains htmlTemplate.
 * Console methods are intercepted and piped via postMessage.
 *
 * @param {string} jsCode        — user JavaScript
 * @param {string} htmlTemplate  — HTML+CSS from the template editor
 */
function runInBrowser(jsCode, htmlTemplate) {
    if (!jsCode) return;

    elBrowserConsole.innerHTML = '';
    appendBrowserLog('info', ['▶ Running…']);

    // Escape </script> in user code so it doesn't break the srcdoc
    const safeJs   = jsCode.replace(/<\/script>/gi, '<\\/script>');
    const safeHtml = (htmlTemplate || '').replace(/<\/script>/gi, '<\\/script>');

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

    const srcdoc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px; line-height: 1.5;
    background: ${isDark ? '#111827' : '#ffffff'};
    color: ${isDark ? '#f9fafb' : '#111'};
  }
  a { color: #6c8ef7; }
  pre, code { font-family: 'JetBrains Mono', monospace; font-size: 13px; }
</style>
<script>
/* ── Console bridge: pipe everything to parent via postMessage ─── */
(function () {
  var _send = function (level, args) {
    var parts = Array.prototype.slice.call(args).map(function (a) {
      if (a === null)      return 'null';
      if (a === undefined) return 'undefined';
      if (typeof a === 'object') {
        try { return JSON.stringify(a, null, 2); } catch (e) { return String(a); }
      }
      return String(a);
    });
    window.parent.postMessage({ type: 'br-console', level: level, args: parts }, '*');
  };
  window.console = {
    log:   function () { _send('log',   arguments); },
    info:  function () { _send('info',  arguments); },
    warn:  function () { _send('warn',  arguments); },
    error: function () { _send('error', arguments); },
    dir:   function () { _send('log',   arguments); },
    table: function () { _send('log',   arguments); },
    debug: function () { _send('log',   arguments); },
    group: function () {}, groupEnd: function () {}, groupCollapsed: function () {},
    time:  function () {}, timeEnd: function () {},
    clear: function () { window.parent.postMessage({ type: 'br-clear' }, '*'); },
  };
  window.onerror = function (msg, src, line, col, err) {
    window.parent.postMessage({ type: 'br-error', message: msg, line: line || 0 }, '*');
    return false;
  };
  window.addEventListener('unhandledrejection', function (e) {
    var msg = (e.reason && e.reason.message) ? e.reason.message : String(e.reason);
    window.parent.postMessage({ type: 'br-error', message: 'Unhandled rejection: ' + msg, line: 0 }, '*');
  });
  /* Signal script-done after all microtasks have run */
  document.addEventListener('DOMContentLoaded', function () {
    Promise.resolve().then(function () {
      window.parent.postMessage({ type: 'br-done' }, '*');
    });
  });
})();
<\/script>
</head>
<body>
${safeHtml}
<script>
try {
  ${safeJs}
} catch (e) {
  window.parent.postMessage({ type: 'br-error', message: e.message || String(e), line: 0 }, '*');
}
<\/script>
</body>
</html>`;

    // Setting srcdoc reloads the iframe
    elBrowserIframe.srcdoc = srcdoc;

    // Pulse the address bar
    if (elBrowserAddrBar) {
        elBrowserAddrBar.textContent = 'sandbox://browser-run — running…';
        setTimeout(() => {
            if (elBrowserAddrBar) elBrowserAddrBar.textContent = 'sandbox://browser-run';
        }, 800);
    }
}

/** Receive postMessage events from the sandboxed iframe */
window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;
    switch (e.data.type) {
        case 'br-console':
            appendBrowserLog(e.data.level, e.data.args);
            break;
        case 'br-error':
            appendBrowserLog('error', [
                `${e.data.message}${e.data.line ? ' (line ' + e.data.line + ')' : ''}`
            ]);
            break;
        case 'br-clear':
            elBrowserConsole.innerHTML = '';
            break;
        case 'br-done':
            appendBrowserLog('done', ['✔ Execution complete']);
            break;
    }
});

/**
 * Append a styled line to the browser console panel.
 * @param {'log'|'info'|'warn'|'error'|'done'} level
 * @param {string[]} args
 */
function appendBrowserLog(level, args) {
    const line = document.createElement('div');
    line.className = `br-log br-log-${level}`;

    const icon = document.createElement('span');
    icon.className = 'br-log-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent =
        level === 'error' ? '✖' :
        level === 'warn'  ? '⚠' :
        level === 'done'  ? '✔' : '›';

    const text = document.createElement('span');
    text.className = 'br-log-text';
    text.textContent = args.join('  ');

    line.appendChild(icon);
    line.appendChild(text);
    elBrowserConsole.appendChild(line);
    elBrowserConsole.scrollTop = elBrowserConsole.scrollHeight;
}

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
    elStepsInfo.textContent      = '— steps';
    elCurrentLineNum.textContent = '—';
    elStepCounter.textContent    = '—';
    elProgressFill.style.width   = '0%';
    clearEditorHighlight();

    // Reset browser panel
    if (elBrowserIframe)  elBrowserIframe.srcdoc  = '';
    if (elBrowserConsole) elBrowserConsole.innerHTML = '';
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
   9. COMPILE / RUN BUTTON
   ═══════════════════════════════════════════════════════════════ */
elBtnCompile.addEventListener('click', async () => {
    if (!editor) return;
    const code = editor.getValue().trim();
    if (!code) { setConsole('[ERROR] Code is empty.'); return; }

    /* ── JS Browser Run mode: skip backend, run directly in iframe ── */
    if (currentLang === 'javascript' && jsRunMode === 'browser') {
        runInBrowser(code, elHtmlEditor ? elHtmlEditor.value : '');
        return;
    }

    // ── Memory Trace mode: send to backend ───────────────────────
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

        const response = await fetch(API_ENDPOINT, {
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
            let msg = `[${
                data.runtimeError === 'TimeoutError' ? 'TIMEOUT' :
                data.errors?.length ? 'COMPILE ERROR' : 'ERROR'
            }] ${data.message || 'Unknown error'}\n`;
            if (data.errors?.length) {
                data.errors.forEach(e => { msg += `  Line ${e.line}: ${e.message}\n`; });
            }
            setConsole(msg);
            showEmptyState('Compilation failed');
            return;
        }

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
   11. RENDER STEP  (no stdout strip — console is in left panel)
   ═══════════════════════════════════════════════════════════════ */
function renderStep() {
    if (executionSteps.length === 0) return;
    const step = executionSteps[currentStepIndex];

    elBtnPrev.disabled = currentStepIndex === 0;
    elBtnNext.disabled = currentStepIndex === executionSteps.length - 1;
    elStepCounter.textContent = `${currentStepIndex + 1} / ${executionSteps.length}`;

    const pct = executionSteps.length > 1
        ? (currentStepIndex / (executionSteps.length - 1)) * 100 : 100;
    elProgressFill.style.width = `${pct}%`;

    elCurrentLineNum.textContent = String(step.currentLine || '—');

    renderStack(step.stack || {});
    renderHeap(step.heap || {});

    requestAnimationFrame(() =>
        requestAnimationFrame(() => drawArrows(step.stack || {}, step.heap || {}))
    );

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
            collapsedHeapObjects.has(objId)
                ? collapsedHeapObjects.delete(objId)
                : collapsedHeapObjects.add(objId);
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

const redrawArrows = () => {
    if (executionSteps.length === 0) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const step = executionSteps[currentStepIndex];
        if (step) drawArrows(step.stack || {}, step.heap || {});
    }));
};

elStackContainer.addEventListener('scroll', redrawArrows);
elHeapContainer.addEventListener('scroll', redrawArrows);
window.addEventListener('resize', () => {
    redrawArrows();
    // Re-position tab ink on resize
    requestAnimationFrame(() => updateTabInk(jsRunMode));
});

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
