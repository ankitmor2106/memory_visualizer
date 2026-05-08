# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM eclipse-temurin:17-jdk-jammy AS java-builder
WORKDIR /build
# Validate javac is present
RUN javac --version

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM ubuntu:22.04

# Avoid apt prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# ─── System layer: Install all language runtimes ──────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-dev python3-pip \
    openjdk-17-jdk \
    curl gnupg \
    gcc g++ gdb \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ─── Set Python 3.11 as default ───────────────────────────────────────────────
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
    && update-alternatives --set python3 /usr/bin/python3.11

# ─── Application Workspace ────────────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# ─── Application source ───────────────────────────────────────────────────────
COPY . .

# ─── Compile JvmTraceAgent.java ───────────────────────────────────────────────
# We use a heredoc (<<EOF) so the Docker parser ignores the word 'from' 
# inside the Python script.
ENV TOOLS_JAR=/usr/lib/jvm/java-17-openjdk-amd64/lib/tools.jar
RUN python3.11 <<EOF
import pathlib, subprocess, os, sys
# Import the source constant from your tracer file
from tracers.java_tracer import JAVA_AGENT_SOURCE

src = pathlib.Path('/app/JvmTraceAgent.java')
src.write_text(JAVA_AGENT_SOURCE)

cp = os.environ.get('TOOLS_JAR', '/usr/lib/jvm/java-17-openjdk-amd64/lib/tools.jar')
r = subprocess.run(['javac', '-cp', cp, str(src), '-d', '/app/'], capture_output=True)

if r.returncode != 0:
    print(r.stderr.decode(), file=sys.stderr)
    sys.exit(1)
print('JvmTraceAgent compiled OK')
EOF

# ─── Security: non-root user ──────────────────────────────────────────────────
RUN useradd -r -s /usr/sbin/nologin apiuser \
    && chown -R apiuser:apiuser /app
USER apiuser

# ─── Runtime config ───────────────────────────────────────────────────────────
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
# Near the bottom of your Dockerfile
RUN mkdir -p /app/temp && chmod 777 /app/temp
USER apiuser
