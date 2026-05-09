# ═══════════════════════════════════════════════════════════════════════════
#  Polyglot Memory Visualizer — Production Dockerfile
#  Base: Ubuntu 22.04 LTS
#  Installs: Python 3.11 · OpenJDK 17 · Node.js 20 · g++ · GDB · util-linux
#
#  Key production hardening
#  ────────────────────────
#  • util-linux provides `prlimit` so the C++ tracer can cage untrusted
#    binaries with OS-enforced memory / CPU / fd limits before exec.
#  • Non-root user `apiuser` owns the application directory.
#  • CMD uses shell form to honour the $PORT environment variable that
#    Render.com (and similar PaaS platforms) inject at runtime.
# ═══════════════════════════════════════════════════════════════════════════

FROM ubuntu:22.04

# ── Build-time env ────────────────────────────────────────────────────────────
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AGENT_CLASS_DIR=/app

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        # Python runtime
        python3.11 \
        python3.11-dev \
        python3-pip \
        # Java runtime (JDK needed for javac + JDWP)
        openjdk-17-jdk \
        # C / C++ toolchain + debugger
        gcc \
        g++ \
        gdb \
        # prlimit lives here — REQUIRED for C++ sandbox
        util-linux \
        # Node.js setup prerequisite
        curl \
        gnupg \
        ca-certificates \
    # ── Node.js 20 LTS ────────────────────────────────────────────────────────
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    # ── Cleanup ───────────────────────────────────────────────────────────────
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ── Python 3.11 as default python3 ───────────────────────────────────────────
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
 && update-alternatives --set python3 /usr/bin/python3.11

# ── Application workspace ─────────────────────────────────────────────────────
WORKDIR /app

# Install Python dependencies first (layer caching)
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy all application source
COPY . .

# ── Compile JvmTraceAgent.java ────────────────────────────────────────────────
# The Java agent source is embedded as a string constant in java_tracer.py.
# We extract it at build time, compile it once, and leave the .class in /app.
# JDK 17: com.sun.jdi is in the jdk.jdi module — no tools.jar needed.
RUN python3.11 -c "\
import pathlib, subprocess, sys; \
sys.path.insert(0, '/app'); \
from tracers.java_tracer import JAVA_AGENT_SOURCE; \
src = pathlib.Path('/app/JvmTraceAgent.java'); \
src.write_text(JAVA_AGENT_SOURCE); \
r = subprocess.run( \
    ['javac', str(src), '-d', '/app/'], \
    capture_output=True \
); \
print(r.stdout.decode()); \
sys.stderr.write(r.stderr.decode()); \
sys.exit(r.returncode) \
"

# ── Temp directory for tracer working files ───────────────────────────────────
RUN mkdir -p /app/temp && chmod 777 /app/temp \
 && mkdir -p /tmp && chmod 1777 /tmp

# ── Non-root security user ────────────────────────────────────────────────────
RUN useradd -r -s /usr/sbin/nologin apiuser \
 && chown -R apiuser:apiuser /app
USER apiuser

# ── Runtime ───────────────────────────────────────────────────────────────────
EXPOSE 8080

# Shell form is required so the shell expands ${PORT:-8080}.
# Render.com injects $PORT at container start; local runs default to 8080.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
