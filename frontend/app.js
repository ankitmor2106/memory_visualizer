document.addEventListener('DOMContentLoaded', () => {
    // --- UI ELEMENTS ---
    const btnCompile = document.getElementById('btn-compile');
    const btnRun = document.getElementById('btn-run');
    const btnVisualize = document.getElementById('btn-visualize');
    
    const btnNext = document.getElementById('btn-next');
    const btnPrev = document.getElementById('btn-prev');
    const btnCloseModal = document.getElementById('btn-close-modal');
    
    const stepCounter = document.getElementById('step-counter');
    const stackContainer = document.getElementById('stack-container');
    const heapContainer = document.getElementById('heap-container');
    
    const consoleOutput = document.getElementById('console-output');
    const themeToggle = document.getElementById('theme-toggle');
    const visualizerModal = document.getElementById('visualizer-modal');
    const compileBtnText = document.getElementById('compile-btn-text');

    const langButtons = document.querySelectorAll('.lang-btn');
    const docSections = document.querySelectorAll('.lang-docs');
    const consolePanel = document.querySelector('.console-panel');
    const resizeHandle = document.getElementById('console-resize-handle');

    // --- STATE & MULTI-LANGUAGE DEFAULTS ---
    let currentLanguage = 'java'; // Default
    let executionSteps = [];
    let fullStdout = "";
    let runtimeError = null;
    let currentStepIndex = 0;
    let editor;

    // Boilerplate code for each language
    const DEFAULT_CODES = {
        'java': `class A {\n    String name;\n    A(String n) { name = n; }\n}\n\npublic class Main {\n    public static void main(String[] args) {\n        A[] a = {\n            new A("Ankit"),\n            new A("Rahul")\n        };\n        for (A x : a) System.out.println(x.name);\n    }\n}`,
        'python': `def calculate(a, b):\n    return a + b\n\ndef main():\n    data = {"name": "Memory Visualizer", "version": 2.0}\n    result = calculate(5, 10)\n    print("Python Memory OK. Result:", result)\n\nif __name__ == "__main__":\n    main()`,
        'cpp': `#include <iostream>\n#include <string>\nusing namespace std;\n\nint main() {\n    string msg = "Hello from C++ Memory!";\n    cout << msg << endl;\n    return 0;\n}`,
        'javascript': `function main() {\n    const obj = { platform: "Node.js", ready: true };\n    const arr = [1, 2, 3];\n    console.log("Hello from JS Memory!");\n}\nmain();`
    };

    // Map your frontend IDs to Monaco's internal language IDs
    const MONACO_LANG_MAP = { 
        'java': 'java', 
        'python': 'python', 
        'cpp': 'cpp', 
        'javascript': 'javascript' 
    };

    // --- THEME LOGIC & CANVAS OPACITY ---
    let particlesColor = 'rgba(255, 255, 255, 0.7)'; 
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        themeToggle.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
        
        particlesColor = theme === 'dark' ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.4)';
        
        if(editor) monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs-light');
    }
    applyTheme(localStorage.getItem('java-vis-theme') || 'dark');
    themeToggle.addEventListener('click', () => {
        const newTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        localStorage.setItem('java-vis-theme', newTheme);
        applyTheme(newTheme);
    });

    // --- INITIALIZE MONACO EDITOR ---
    require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.36.1/min/vs' }});
    require(['vs/editor/editor.main'], function () {
        const savedTheme = localStorage.getItem('java-vis-theme') || 'dark';
        editor = monaco.editor.create(document.getElementById('editor-container'), {
            value: DEFAULT_CODES[currentLanguage],
            language: MONACO_LANG_MAP[currentLanguage],
            theme: savedTheme === 'dark' ? 'vs-dark' : 'vs-light',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 15,
            padding: { top: 16 }
        });

        // Smart Lock: Disable Run/Visualize buttons if user modifies the code
        editor.onDidChangeModelContent(() => {
            if (!btnRun.disabled) {
                btnRun.disabled = true;
                btnVisualize.disabled = true;
                consoleOutput.textContent = "Code has been modified.\nPlease click 'Compile' to trace new changes.";
            }
        });
    });

    // --- LANGUAGE SWITCHER LOGIC ---
    langButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Update Button States & ARIA
            langButtons.forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-pressed', 'false');
            });
            const target = e.currentTarget;
            target.classList.add('active');
            target.setAttribute('aria-pressed', 'true');
            
            // Update State
            currentLanguage = target.getAttribute('data-lang');
            
            // Update Monaco Editor
            if (editor) {
                monaco.editor.setModelLanguage(editor.getModel(), MONACO_LANG_MAP[currentLanguage]);
                editor.setValue(DEFAULT_CODES[currentLanguage]);
            }
            
            // Update Documentation Visibility
            docSections.forEach(section => {
                if (section.id === `docs-${currentLanguage}`) {
                    section.classList.add('active');
                } else {
                    section.classList.remove('active');
                }
            });
            
            // Reset UI execution state
            consoleOutput.textContent = `Awaiting execution...\nReady to trace ${target.querySelector('.lang-name').textContent} code.`;
            btnRun.disabled = true;
            btnVisualize.disabled = true;
            compileBtnText.textContent = "Compile";
        });
    });

    // --- CONSOLE RESIZER LOGIC ---
    let isResizing = false;
    let startY, startHeight;

    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = parseInt(document.defaultView.getComputedStyle(consolePanel).height, 10);
        resizeHandle.classList.add('active');
        document.body.style.cursor = 'ns-resize'; 
        e.preventDefault(); 
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        // ADD the difference because dragging down (higher Y) increases height
        const newHeight = startHeight + (e.clientY - startY); 
        
        if (newHeight > 100 && newHeight < window.innerHeight * 0.8) {
            consolePanel.style.height = `${newHeight}px`;
            if (editor) editor.layout(); 
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            resizeHandle.classList.remove('active');
            document.body.style.cursor = 'default';
        }
    });

    // --- API & BUTTON LOGIC ---
    const API_ENDPOINT = 'http://127.0.0.1:8080/execute';

    // 1. COMPILE BUTTON
    btnCompile.addEventListener('click', async () => {
        const sourceCode = editor.getValue();
        
        consoleOutput.textContent = "Compiling and analyzing code...";
        btnCompile.disabled = true;
        compileBtnText.textContent = "Processing...";
        
        btnRun.disabled = true;
        btnVisualize.disabled = true;

        try {
            const response = await fetch(API_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    code: sourceCode,
                    language: currentLanguage 
                })
            });

            const backendData = await response.json();

            if (!response.ok || backendData.success === false) {
                let errorMsg = backendData.message || `Server Error: ${response.status}`;
                if (backendData.errors && backendData.errors.length > 0) {
                    errorMsg += "\n\n" + backendData.errors.map(e => `Line ${e.line}: ${e.message}`).join("\n");
                }
                throw new Error(errorMsg);
            }
            
            // Store data globally for the sub-buttons to use
            executionSteps = backendData.steps || [];
            runtimeError = backendData.runtimeError;
            
            // Extract the final cumulative output for the "Run" button
            fullStdout = executionSteps.length > 0 ? executionSteps[executionSteps.length - 1].stdout : "";
            
            consoleOutput.textContent = "Compilation Successful! ✅\n\nCode is ready.\n- Click 'Run' to see output.\n- Click 'Visualize' to trace memory.";
            
            // Unlock the smaller buttons
            btnRun.disabled = false;
            if (executionSteps.length > 0) {
                btnVisualize.disabled = false; 
            }

        } catch (error) {
            consoleOutput.textContent = `[COMPILATION ERROR]\n\nDetails: ${error.message}\n`;
            console.error("Backend Error:", error);
        } finally {
            btnCompile.disabled = false;
            compileBtnText.textContent = "Compile";
        }
    });

    // 2. RUN BUTTON (Shows terminal output instantly)
    btnRun.addEventListener('click', () => {
        let outputText = "--- Console Output ---\n";
        outputText += fullStdout || "(No output generated)";
        
        if (runtimeError) {
            outputText += `\n\n[RUNTIME EXCEPTION]:\n${runtimeError}`;
        }
        consoleOutput.textContent = outputText;
    });

    // 3. VISUALIZE BUTTON (Opens the Glass Modal)
    btnVisualize.addEventListener('click', () => {
        visualizerModal.classList.remove('hidden');
        document.body.classList.add('no-scroll'); 
        currentStepIndex = 0;
        updateUI();
    });

    // --- MODAL & RENDERING LOGIC ---
    btnCloseModal.addEventListener('click', () => {
        visualizerModal.classList.add('hidden');
        document.body.classList.remove('no-scroll'); 
    });

    btnNext.addEventListener('click', () => { if (currentStepIndex < executionSteps.length - 1) { currentStepIndex++; updateUI(); } });
    btnPrev.addEventListener('click', () => { if (currentStepIndex > 0) { currentStepIndex--; updateUI(); } });

    function updateUI() {
        if (executionSteps.length === 0) return;
        const currentState = executionSteps[currentStepIndex];

        btnPrev.disabled = currentStepIndex === 0;
        btnNext.disabled = currentStepIndex === executionSteps.length - 1;
        stepCounter.textContent = `Step: ${currentStepIndex + 1} / ${executionSteps.length}`;

        renderStack(currentState.stack);
        renderHeap(currentState.heap);
        setTimeout(drawArrows, 50); 
    }

    function renderStack(stackData) {
        stackContainer.innerHTML = '';
        
        for (const [methodName, variables] of Object.entries(stackData)) {
            stackContainer.innerHTML += `
                <div style="font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; margin: 10px 0 5px 5px; letter-spacing: 1px;">
                    Frame: ${methodName}()
                </div>`;

            for (const [varName, varString] of Object.entries(variables)) {
                // Ensure varString is treated as a string to prevent .indexOf errors
                const stringVal = String(varString);
                
                let type = "var";
                let val = stringVal;
                let isRef = false;
                let targetId = "";
                
                // If the backend passes "ref: obj_123"
                if (stringVal.startsWith("ref: ")) {
                    isRef = true;
                    targetId = stringVal.substring(5).trim(); 
                    val = "Object " + targetId.replace("obj_", "").replace("arr_", "").replace("box_", ""); 
                    type = "ref";
                } else if (stringVal.indexOf(':') !== -1) {
                    // Legacy parsing if backend sends "type : value"
                    const splitIndex = stringVal.indexOf(':');
                    type = stringVal.substring(0, splitIndex).trim();
                    val = stringVal.substring(splitIndex + 1).trim();
                }

                const valClass = isRef ? `ref` : "val";
                const domId = `stack-${methodName.replace(/[^a-zA-Z0-9]/g, '')}-${varName}`; 

                stackContainer.innerHTML += `
                    <div class="stack-row" id="${domId}">
                        <div><span class="type">${type}</span><span class="name">${varName}</span></div>
                        <span class="${valClass}" ${isRef ? `data-target="${targetId}" data-source="${domId}"` : ""}>${val}</span>
                    </div>
                `;
            }
        }
    }

    function renderHeap(heapData) {
        heapContainer.innerHTML = '';
        for (const [objId, objData] of Object.entries(heapData)) {
            let fieldsHtml = '';
            
            if (objData.fields && Object.keys(objData.fields).length > 0) {
                for (const [key, val] of Object.entries(objData.fields)) {
                    fieldsHtml += `<div class="obj-row"><div class="obj-key">${key}</div><div class="obj-val">${val}</div></div>`;
                }
            } else if (objData.value) {
                fieldsHtml = `<div class="obj-row"><div class="obj-key" style="flex:0;">[ ]</div><div class="obj-val">${objData.value}</div></div>`;
            }

            const formattedId = objId.startsWith('obj_') ? 'Object ' + objId.substring(4) : objId;

            heapContainer.innerHTML += `
                <div class="heap-object" id="heap-${objId}">
                    <div class="obj-header">${objData.type} <span class="ref-id">@${formattedId}</span></div>
                    <div class="obj-body">${fieldsHtml}</div>
                </div>
            `;
        }
    }

    function drawArrows() {
        const svg = document.getElementById('arrow-svg');
        if (!svg) return;
        svg.querySelectorAll('path').forEach(p => p.remove());

        const pointers = document.querySelectorAll('.ref');
        const containerRect = document.getElementById('memory-grid').getBoundingClientRect();
        const stackRect = stackContainer.getBoundingClientRect();
        const heapRect = heapContainer.getBoundingClientRect();

        pointers.forEach(pointer => {
            const targetNode = document.getElementById(`heap-${pointer.getAttribute('data-target')}`);
            const sourceRow = document.getElementById(pointer.getAttribute('data-source'));
            
            if (targetNode && sourceRow) {
                const pRect = pointer.getBoundingClientRect();
                const tRect = targetNode.getBoundingClientRect();

                // Skip drawing if either element is scrolled out of view
                if (pRect.top < stackRect.top || pRect.bottom > stackRect.bottom) return;
                if (tRect.top < heapRect.top || tRect.bottom > heapRect.bottom) return;

                const startX = pRect.right - containerRect.left;
                const startY = pRect.top + pRect.height / 2 - containerRect.top;
                const endX = tRect.left - containerRect.left; 
                const endY = tRect.top + tRect.height / 2 - containerRect.top;

                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                const cp1X = startX + 100;
                const cp2X = endX - 100;
                
                path.setAttribute('d', `M ${startX} ${startY} C ${cp1X} ${startY}, ${cp2X} ${endY}, ${endX} ${endY}`);
                path.setAttribute('fill', 'none');
                path.setAttribute('stroke', 'var(--text-muted)');
                path.setAttribute('stroke-width', '2');
                path.setAttribute('stroke-opacity', '0.4'); 
                path.setAttribute('marker-end', 'url(#arrowhead)');
                svg.appendChild(path);

                const highlightConnection = () => {
                    path.setAttribute('stroke', 'var(--accent)');
                    path.setAttribute('stroke-width', '3');
                    path.setAttribute('stroke-opacity', '1');
                    path.setAttribute('marker-end', 'url(#arrowhead-highlight)');
                    targetNode.classList.add('highlighted');
                    sourceRow.classList.add('highlighted');
                };

                const removeHighlight = () => {
                    path.setAttribute('stroke', 'var(--text-muted)');
                    path.setAttribute('stroke-width', '2');
                    path.setAttribute('stroke-opacity', '0.4');
                    path.setAttribute('marker-end', 'url(#arrowhead)');
                    targetNode.classList.remove('highlighted');
                    sourceRow.classList.remove('highlighted');
                };

                pointer.addEventListener('mouseenter', highlightConnection);
                pointer.addEventListener('mouseleave', removeHighlight);
                targetNode.addEventListener('mouseenter', highlightConnection);
                targetNode.addEventListener('mouseleave', removeHighlight);
            }
        });
    }

    window.addEventListener('resize', () => { if(!visualizerModal.classList.contains('hidden')) drawArrows(); });
    stackContainer.addEventListener('scroll', drawArrows);
    heapContainer.addEventListener('scroll', drawArrows);

    // --- INTERACTIVE CANVAS BACKGROUND ---
    const canvas = document.getElementById('bg-canvas');
    const ctx = canvas.getContext('2d');
    let width, height, particles = [];

    function initCanvas() {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
        particles = [];
        for(let i = 0; i < 70; i++) { 
            particles.push({ x: Math.random() * width, y: Math.random() * height, vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5 });
        }
    }

    function drawCanvas() {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = particlesColor;
        ctx.strokeStyle = particlesColor;
        
        particles.forEach(p => {
            p.x += p.vx; p.y += p.vy;
            if(p.x < 0 || p.x > width) p.vx *= -1;
            if(p.y < 0 || p.y > height) p.vy *= -1;
            
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
            ctx.fill();
        });

        for(let i = 0; i < particles.length; i++) {
            for(let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if(dist < 150) {
                    ctx.globalAlpha = 1 - (dist / 150); 
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.stroke();
                }
            }
        }
        ctx.globalAlpha = 1;
        requestAnimationFrame(drawCanvas);
    }
    window.addEventListener('resize', initCanvas);
    initCanvas();
    drawCanvas();
});