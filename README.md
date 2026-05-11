# Polyglot Memory Visualizer

A runtime execution tracing platform that lets you step through code line-by-line and watch Call Stack frames and Heap objects evolve in real time — across four languages.

**Live Demo →** [Frontend on GitHub Pages](https://ankitmor2106.github.io/memory-visualizer/frontend/index.html) &nbsp;|&nbsp; **API →** [Backend on Render](https://memory-visualizer.onrender.com)

---

## What It Does

Most debuggers show you *what went wrong*. This tool shows you *how memory changes* — one line at a time.

Paste any Java, Python, JavaScript, or C++ snippet, hit **Compile**, then step through an animated visualization of every local variable, object reference, heap allocation, and stack frame, with SVG arrows connecting stack slots to heap objects.

---

## Screenshots

> Swap in actual screenshots once the app is live. Suggested captures:
> - The Monaco editor + control panel (dark mode)
> - The Visualizer modal open, showing stack ↔ heap arrows
> - The light-mode variant

---

## Feature Highlights

| Feature | Detail |
|---|---|
| **Step-through execution** | Step forward/backward through up to 500 captured trace snapshots |
| **Call Stack panel** | Every active frame and its local variables, updated each step |
| **Heap panel** | Heap-allocated objects and arrays with field-level drill-down |
| **Reference arrows** | Animated SVG Bézier curves connecting stack references to heap targets; hover to highlight a path |
| **Stdout capture** | Console/print output accumulated and shown per step |
| **Smart Lock** | Editing code after compilation invalidates the trace and locks playback until re-compiled |
| **Monaco Editor** | Full syntax highlighting + IntelliSense for all four languages |
| **Dark / Light theme** | Persisted in `localStorage`, applied to both the UI and Monaco |
| **Responsive layout** | Adapts to mobile; resizable console panel via drag handle |
| **Animated canvas** | Particle network background that reacts to window size |

---

## Language Support

| Language | Tracing Technology | Heap Depth | Notes |
|---|---|---|---|
| **Java** | JDWP + custom JDI agent (`JvmTraceAgent.java`) | 3 levels | 128 MB JVM cap; compiled once at image build |
| **Python** | `sys.settrace()` in a sandboxed namespace | Shallow (1 level) | 256 MB RLIMIT_AS; dangerous builtins removed |
| **JavaScript** | V8 Inspector Protocol (CDP) over WebSocket | 1 level | Node.js `--inspect-brk`; console.log captured |
| **C++** | GDB Machine Interface (MI) via pexpect | Pointer detection | Compiled with `-g -O0`; GDB MI parsing |

---

## Architecture

```
Browser (GitHub Pages)
  └── Monaco Editor + Glassmorphism UI (app.js / style.css)
        │  POST /execute  { code, language }
        ▼
  FastAPI Orchestrator (Render / Docker)
  └── asyncio.wait_for(tracer(code), timeout=30s)
        ├── python_tracer.py   — sys.settrace sandbox
        ├── java_tracer.py     — JDWP + JvmTraceAgent
        ├── javascript_tracer.py — CDP WebSocket
        └── cpp_tracer.py      — GDB MI (pexpect)
              │
              ▼
        ExecuteResponse
          { success, steps: [{ step, currentLine, stdout, stack, heap }] }
```

Each tracer emits a normalised list of `StepModel` objects. The frontend renders them independently — zero language-specific logic in `app.js`.

---

## Project Structure

```
polyglot-memory-visualizer/
├── backend/
│   ├── main.py                  # FastAPI app + dispatcher
│   ├── models.py                # Pydantic schemas
│   ├── requirements.txt
│   ├── Dockerfile
│   └── tracers/
│       ├── python_tracer.py
│       ├── java_tracer.py       # embeds JvmTraceAgent.java source
│       ├── javascript_tracer.py
│       └── cpp_tracer.py
├── frontend/
│   ├── index.html               # Single-page app
│   ├── style.css                # CSS variables, glassmorphism, responsive
│   └── app.js                   # Monaco setup, API calls, rendering
├── .github/
│   └── workflows/
│       └── deploy-frontend.yml  # Auto-deploy frontend → GitHub Pages
└── README.md
```

---

## Local Development

### Prerequisites

| Tool | Version |
|---|---|
| Python | 3.11+ |
| Java (JDK) | 17+ |
| Node.js | 20+ |
| GDB | any recent |
| Docker (optional) | 24+ |

### Backend

```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Compile the JDI agent once (only needed locally)
export TOOLS_JAR=/usr/lib/jvm/java-17-openjdk-amd64/lib/tools.jar  # adjust path
python3 -c "
import pathlib, subprocess, os
from tracers.java_tracer import JAVA_AGENT_SOURCE
src = pathlib.Path('JvmTraceAgent.java')
src.write_text(JAVA_AGENT_SOURCE)
subprocess.run(['javac', '-cp', os.environ['TOOLS_JAR'], str(src), '-d', '.'], check=True)
print('JvmTraceAgent compiled OK')
"

uvicorn main:app --reload --port 8080
```

### Frontend

The frontend is pure static HTML — no build step needed.

```bash
# Point the API endpoint to localhost
# In frontend/app.js, change:
#   const API_ENDPOINT = 'https://memory-visualizer.onrender.com/execute';
# to:
#   const API_ENDPOINT = 'http://localhost:8080/execute';

# Then open the file directly or serve it:
cd frontend
python3 -m http.server 3000
# Visit http://localhost:3000
```

---

## Docker Deployment

```bash
# Build
docker build -t polyglot-viz ./backend

# Run
docker run -p 8080:8080 polyglot-viz

# Or with docker-compose (if you have a compose file):
docker-compose up --build
```

The `Dockerfile` handles:
1. Installing Python 3.11, OpenJDK 17, Node.js 20, GDB, g++ in one layer
2. Compiling `JvmTraceAgent.java` at image build time (so runtime startup is instant)
3. Running as a non-root `apiuser` for security

---

## API Reference

### `POST /execute`

```json
{
  "language": "java",   // "java" | "python" | "javascript" | "cpp"
  "code": "public class Main { ... }"
}
```

**Response**

```json
{
  "success": true,
  "message": "OK",
  "errors": [],
  "runtimeError": null,
  "totalSteps": 14,
  "steps": [
    {
      "step": 1,
      "currentLine": 5,
      "stdout": "",
      "stack": {
        "Main.main": { "args": "ref: obj_1", "x": "42" }
      },
      "heap": {
        "obj_1": { "type": "String[]", "value": "[0 items]", "fields": {} }
      }
    }
  ]
}
```

- `errors` is populated for compile-time failures (with line numbers).
- `runtimeError` is populated for runtime exceptions or timeouts.
- Steps are capped at **500** server-side.
- The global timeout is **30 seconds** per request.

### `GET /health`

Returns `{ "status": "ok" }` — useful for uptime checks.

---

## Security Model

| Layer | Protection |
|---|---|
| Python | Restricted `__builtins__` whitelist; `resource.RLIMIT_AS` 256 MB cap; isolated `exec()` namespace |
| Java | 128 MB JVM heap (`-Xmx128m`); separate process; classpath restricted to temp dir |
| JavaScript | Separate Node.js child process; killed after trace completes |
| C++ | Separate GDB child process; `pexpect` timeout; temp directory cleaned up |
| All | 30-second `asyncio.wait_for` hard wall-clock limit; 500-step trace cap |
| Docker | Runs as non-root `apiuser` |

---

## CI / CD

| Pipeline | Trigger | Action |
|---|---|---|
| `deploy-frontend.yml` | Push to `main` touching `frontend/**` | Publishes `./frontend` to GitHub Pages via `peaceiris/actions-gh-pages` |

Backend is deployed manually (or via Render's GitHub integration) by pushing to `main`.

---

## How the Java Tracer Works (Deep Dive)

1. **Compile** — `javac` compiles user code into a temp directory.
2. **Launch JVM with JDWP** — The JVM starts with `suspend=y` and `address=127.0.0.1:0`; the OS assigns a free port, which is read from stderr.
3. **Attach JvmTraceAgent** — A custom Java program (`JvmTraceAgent.java`, embedded as a Python string and compiled once at image build) attaches via JDI `SocketAttach`.
4. **Step + Inspect** — The agent enables `StepRequest.STEP_LINE` on all threads, then emits one JSON line per step containing the full stack frame list and a heap object graph (traversed 3 levels deep).
5. **Parse** — Python reads the newline-delimited JSON stream and assembles `StepModel` objects.
6. **Cleanup** — Both the JVM process and the agent process are killed after the trace completes or an exception is thrown.

---

## How the Python Tracer Works (Deep Dive)

1. **Compile** — `compile(code, "<user>", "exec")` surfaces `SyntaxError` before execution.
2. **Sandbox** — A restricted globals dict is built with only whitelisted builtins (no `open`, `__import__`, `exec`, `eval`, etc.).
3. **Trace** — `sys.settrace` installs a callback that fires on every `line` and `call` event inside the user's file.
4. **Snapshot** — On each event, the full frame chain is walked (innermost first). Each variable is encoded: primitives inline, mutable containers/objects into a `heap` dict with a stable `obj_<id()>` key.
5. **Restore** — `sys.settrace` is restored in a `finally` block so the FastAPI server's own trace (if any) is not corrupted.

---

## Contributing

Pull requests are welcome. For significant changes, open an issue first to discuss the design.

```bash
# Fork, clone, create a branch
git checkout -b feature/my-improvement

# Make changes, test locally
# ...

git commit -m "feat: describe your change"
git push origin feature/my-improvement
# Open a PR
```

Please ensure:
- New tracer code follows the `async def run_<lang>(code: str) -> ExecuteResponse` contract.
- All steps are emitted with valid `currentLine`, `stack`, `heap`, and `stdout` fields.
- The 500-step cap and timeout behaviour are preserved.



## Author

**Ankit Mor**

> *"Understanding memory is the key to understanding software."*
