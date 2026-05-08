# 🚀 Polyglot Memory Visualizer

<div align="center">

<!-- Replace with your banner image -->


### **A  execution tracing platform for visualizing Call Stack & Heap Memory across multiple programming languages.**

*Built for learners, educators, and systems programmers who want to see memory evolve in real time.*

</div>

# ✨ Core Idea

**Polyglot Memory Visualizer** transforms source code execution into an interactive visual experience.

Instead of reading console output, users can:

- Step through execution line-by-line
- Observe stack frame creation/destruction
- Visualize heap allocations in real time
- Track object references with animated SVG pointers
- Understand how memory behaves internally across languages

The platform combines low-level runtime instrumentation with a modern browser-based visualization engine.

---

# 🧠 Key Features

## 🔍 Real-Time Execution Tracing

Supports deep runtime introspection for multiple languages:

| Language | Tracing Technology |
|---|---|
| **Java** | JDWP + Custom JDI Agent |
| **Python** | `sys.settrace()` sandbox tracing |
| **JavaScript** | V8 Inspector Protocol (CDP) |
| **C++** | GDB Machine Interface (MI) |

Each runtime produces normalized execution snapshots consumed by the visualization engine.

---

## 🧩 Interactive Heap & Stack Visualization

- Dynamic Call Stack rendering
- Heap memory graph visualization
- SVG-based reference arrows between objects
- Real-time object lifecycle updates
- Primitive vs reference type distinction
- Array and nested object expansion

---

## 🎨 Modern Glassmorphism UI

The frontend is designed with a polished developer-focused interface featuring:

- Glassmorphism design system
- Smooth transitions and animations
- Monaco Editor integration
- Responsive layout
- Dark / Light theme support
- High-contrast memory node rendering

---

## 🔒 Smart Lock Execution System

A built-in **Smart Lock** mechanism prevents stale execution states.

When users modify code after execution:

- Existing traces become invalidated automatically
- Visualization playback is locked
- Re-execution is required before stepping again

This guarantees synchronization between:

- Source code
- Runtime state
- Visual memory graph

Preventing outdated or misleading visualizations.

---

# 🏗️ System Architecture

```text
                    ┌────────────────────┐
                    │   Monaco Editor    │
                    │  (Frontend UI)     │
                    └─────────┬──────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │ FastAPI Orchestrator│
                   │  Runtime Controller │
                   └─────────┬───────────┘
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
   ┌────────────┐     ┌────────────┐     ┌────────────┐
   │ Python     │     │ Java       │     │ JavaScript │
   │ sys.trace  │     │ JDWP/JDI   │     │ V8/CDP     │
   └────────────┘     └────────────┘     └────────────┘
                              │
                              ▼
                       ┌────────────┐
                       │ C++ GDB MI │
                       └────────────┘
```

---

# ⚙️ Language Runtime Deep Dive

## ☕ Java Runtime Tracing

Java execution is traced using:

- **JDWP (Java Debug Wire Protocol)**
- A custom instrumentation layer:
  - `JvmTraceAgent.java`
- JDI frame inspection
- Heap object reference extraction

### JVM Resource Isolation

Java executions are constrained with:

- **128MB memory cap**
- Timeout enforcement
- Process isolation
- Controlled classpath execution

---

## 🐍 Python Runtime Tracing

Python execution uses:

```python
sys.settrace()
```

inside a restricted execution environment.

### Security Controls

The sandbox:

- Restricts dangerous built-ins
- Blocks filesystem access
- Prevents module abuse
- Limits execution time
- Isolates namespaces

### Resource Limits

Python executions are constrained to:

- **256MB memory limit**
- Restricted recursion depth
- Controlled globals/locals scope

---

## 🟨 JavaScript Runtime Tracing

JavaScript tracing communicates with Node.js using:

- **V8 Inspector Protocol**
- Chrome DevTools Protocol (CDP)

---

## 🔵 C++ Runtime Tracing

C++ support interfaces with:

- **GDB Machine Interface (MI)**
- `pexpect` for subprocess orchestration

---

# 📁 Project Structure

```text
polyglot-memory-visualizer/
│
├── backend/
│   ├── tracers/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── venv/
│   ├── model.py
|   └── main.py
|
│
├── frontend/
│   ├── style.css
│   ├── app.js
│   └── index.html
├── README.md

```

---

# 🐳 Docker Deployment

## Clone Repository

```bash
git clone https://github.com/yourusername/polyglot-memory-visualizer.git

cd polyglot-memory-visualizer
```

## Build Containers

```bash
docker-compose build
```

## Start Services

```bash
docker-compose up
```

---

# 💻 Local Development (macOS)

## Prerequisites

Install:

- Docker Desktop
- Python 3.11+
- Node.js 20+
- OpenJDK 17+
- GDB
- Xcode Command Line Tools

---

# 🔐 Security Model

Executing user-submitted code safely is a core design requirement.

## Sandbox Protections

The platform includes:

- Restricted built-ins
- Memory limits
- Execution timeouts
- Namespace isolation
- Controlled subprocess spawning
- Runtime-specific sandboxing

---

# 👨‍💻 Author

## **Ankit Mor**


> *"Understanding memory is the key to understanding software."*
