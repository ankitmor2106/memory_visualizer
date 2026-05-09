"""
tracers/java_tracer.py

Workflow
────────
1. Write user code to a temp directory and detect the public class name.
2. Compile with `javac`.
3. Launch the JVM with JDWP (suspend=y).
   On JDK 21 (and most modern JDKs) the "Listening at address: PORT" message
   is written to STDOUT, so a single stdout-reader task handles both:
     a) extracting the JDWP port (first line matching the pattern)
     b) accumulating all subsequent lines as user program output
4. Launch JvmTraceAgent over a JDI socket.
5. Parse newline-delimited JSON emitted by the agent.
6. Assemble into ExecuteResponse.

Key fixes vs v2.0
─────────────────
  * JDWP port is read from STDOUT (not stderr) — confirmed on JDK 21.
  * Regex handles "address: PORT" (JDK 21) and "address: 127.0.0.1:PORT" (JDK 9-17).
  * Auto-compiles JvmTraceAgent.java -> .class when .class is missing/stale.
  * JDK tool resolution scans /usr/lib/jvm when java/javac are not on PATH.
  * asyncio.wait_for() guard on JDWP port detection (15 s).
  * Agent stderr captured and surfaced when trace is empty.
"""

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from models import ExecuteResponse, StepModel, HeapObject, ErrorLocation

# ── JDK tool resolution ───────────────────────────────────────────────────────
_JDK_SEARCH = [
    "/usr/lib/jvm",
    "/usr/local/lib/jvm",
    "/opt/java",
    "/opt/jdk",
]

def _find_tool(name: str) -> str:
    candidate = shutil.which(name)
    if candidate:
        return candidate
    for base in _JDK_SEARCH:
        for hit in sorted(Path(base).glob(f"*/bin/{name}"), reverse=True):
            if hit.is_file():
                return str(hit)
    raise RuntimeError(
        f"'{name}' not found on PATH or in {_JDK_SEARCH}. "
        "Please install a full JDK (not just a JRE)."
    )

# ── Agent compilation ─────────────────────────────────────────────────────────
AGENT_CLASS_DIR = Path(os.environ.get(
    "AGENT_CLASS_DIR",
    str(Path(__file__).resolve().parent.parent)
))
AGENT_SOURCE = AGENT_CLASS_DIR / "JvmTraceAgent.java"
AGENT_CLASS  = AGENT_CLASS_DIR / "JvmTraceAgent.class"

def _ensure_agent_compiled() -> None:
    """Compile JvmTraceAgent.java -> .class if missing or stale."""
    if not AGENT_SOURCE.exists():
        raise RuntimeError(f"JvmTraceAgent.java not found at {AGENT_SOURCE}.")
    if (AGENT_CLASS.exists()
            and AGENT_CLASS.stat().st_mtime >= AGENT_SOURCE.stat().st_mtime):
        return
    javac = _find_tool("javac")
    result = subprocess.run(
        [javac, str(AGENT_SOURCE), "-d", str(AGENT_CLASS_DIR)],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Failed to compile JvmTraceAgent.java:\n{result.stderr}"
        )

# ── Patterns ──────────────────────────────────────────────────────────────────
_JAVAC_ERROR_RE = re.compile(r"^.+?:(\d+):\s+error:\s+(.+)$", re.MULTILINE)

# Handles both:
#   "Listening for transport dt_socket at address: 54321"         (JDK 21)
#   "Listening for transport dt_socket at address: 127.0.0.1:54321" (JDK 9-17)
_JDWP_PORT_RE = re.compile(r"address:\s+(?:[\w.]+:)?(\d+)")

JDWP_STDOUT_TIMEOUT = 15  # seconds to wait for the JDWP port line


def _parse_javac_errors(stderr: str) -> list[ErrorLocation]:
    errs = [
        ErrorLocation(line=int(m.group(1)), message=m.group(2).strip())
        for m in _JAVAC_ERROR_RE.finditer(stderr)
    ]
    return errs or [ErrorLocation(line=0, message=stderr.strip()[:500])]


# ── Stdout reader: port detection + user output capture ───────────────────────

async def _read_jvm_stdout(
    stream: asyncio.StreamReader,
    port_found: "asyncio.Future[int]",
    stdout_lines: list[str],
) -> None:
    """
    Read JVM stdout line-by-line serving two purposes:
      - Before port is found: scan for the JDWP address line.
      - After port is found: accumulate lines as user program output.
    The JDWP line itself is NOT added to stdout_lines.
    """
    async for raw in stream:
        line = raw.decode("utf-8", errors="replace")
        if not port_found.done():
            m = _JDWP_PORT_RE.search(line)
            if m:
                port_found.set_result(int(m.group(1)))
            # pre-port JVM warnings / header lines are dropped
        else:
            stdout_lines.append(line)


# ── Main entry point ──────────────────────────────────────────────────────────

async def run_java(code: str) -> ExecuteResponse:
    """Compile and trace Java code via JDWP + JDI agent."""

    # Pre-flight: agent + JDK tools
    try:
        _ensure_agent_compiled()
        java  = _find_tool("java")
        javac = _find_tool("javac")
    except RuntimeError as exc:
        return ExecuteResponse(
            success=False,
            message=str(exc),
            runtimeError=str(exc),
            totalSteps=0,
            steps=[],
        )

    with tempfile.TemporaryDirectory(prefix="jvm_trace_") as tmpdir:
        tmp = Path(tmpdir)

        m = re.search(r"\bpublic\s+class\s+(\w+)", code)
        class_name = m.group(1) if m else "Main"
        src_file = tmp / f"{class_name}.java"
        src_file.write_text(code)

        # ── Step 1: Compile ───────────────────────────────────────────────────
        cp = await asyncio.create_subprocess_exec(
            javac,"-g", str(src_file), "-d", str(tmp),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr_bytes = await cp.communicate()
        if cp.returncode != 0:
            return ExecuteResponse(
                success=False,
                message="Compilation failed",
                errors=_parse_javac_errors(stderr_bytes.decode()),
                totalSteps=0,
                steps=[],
            )

        # ── Step 2: Launch JVM with JDWP ─────────────────────────────────────
        jvm_proc = await asyncio.create_subprocess_exec(
            java,
            "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0",
            "-Xmx128m",
            "-XX:TieredStopAtLevel=1",
            "-cp", str(tmp),
            class_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert jvm_proc.stdout is not None

        # ── Step 3: Read JDWP port from JVM stdout (with timeout) ─────────────
        # IMPORTANT: on JDK 21 the "Listening at address: PORT" line goes to
        # stdout (not stderr). The same stdout stream also carries user program
        # output after the port line, so _read_jvm_stdout handles both roles.
        stdout_lines: list[str] = []
        port_found: asyncio.Future[int] = asyncio.get_event_loop().create_future()

        stdout_task = asyncio.create_task(
            _read_jvm_stdout(jvm_proc.stdout, port_found, stdout_lines)
        )

        try:
            port = await asyncio.wait_for(
                asyncio.shield(port_found), timeout=JDWP_STDOUT_TIMEOUT
            )
        except asyncio.TimeoutError:
            stdout_task.cancel()
            jvm_proc.kill()
            await jvm_proc.wait()
            stderr_dump = ""
            try:
                assert jvm_proc.stderr is not None
                stderr_dump = (await asyncio.wait_for(
                    jvm_proc.stderr.read(), timeout=2.0
                )).decode(errors="replace")[:400]
            except asyncio.TimeoutError:
                pass
            detail = f"\nJVM stderr: {stderr_dump}" if stderr_dump else ""
            return ExecuteResponse(
                success=False,
                message=(
                    f"JVM did not print a JDWP port on stdout within "
                    f"{JDWP_STDOUT_TIMEOUT}s.{detail}"
                ),
                runtimeError="JDWP port timeout",
                totalSteps=0,
                steps=[],
            )

        # ── Step 4: Launch JvmTraceAgent ──────────────────────────────────────
        agent_proc = await asyncio.create_subprocess_exec(
            java, "-cp", str(AGENT_CLASS_DIR), "JvmTraceAgent", str(port),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # ── Step 5: Parse agent NDJSON ────────────────────────────────────────
        steps:         list[StepModel] = []
        runtime_error: str | None      = None

        assert agent_proc.stdout is not None
        async for raw_line in agent_proc.stdout:
            try:
                obj = json.loads(raw_line.decode().strip())
            except json.JSONDecodeError:
                continue

            if obj.get("done"):
                runtime_error = obj.get("runtimeError")
                break

            await asyncio.sleep(0)  # yield so stdout_task can accumulate

            heap = {
                oid: HeapObject(
                    type=ho.get("type", "object"),
                    value=ho.get("value", ""),
                    fields=ho.get("fields", {}),
                )
                for oid, ho in obj.get("heap", {}).items()
            }
            steps.append(StepModel(
                step=obj["step"],
                currentLine=obj["line"],
                stdout="".join(stdout_lines),
                stack=obj.get("stack", {}),
                heap=heap,
            ))

        # Surface agent crash details when trace is empty
        agent_stderr = b""
        if not steps and not runtime_error:
            try:
                assert agent_proc.stderr is not None
                agent_stderr = await asyncio.wait_for(
                    agent_proc.stderr.read(), timeout=2.0
                )
            except asyncio.TimeoutError:
                pass

        # ── Cleanup ───────────────────────────────────────────────────────────
        stdout_task.cancel()
        for proc in (agent_proc, jvm_proc):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        await agent_proc.wait()
        await jvm_proc.wait()

        if not steps and not runtime_error and agent_stderr:
            runtime_error = (
                f"Agent error: {agent_stderr.decode(errors='replace')[:500]}"
            )

        return ExecuteResponse(
            success=runtime_error is None,
            message="OK" if runtime_error is None else "Runtime error",
            runtimeError=runtime_error,
            totalSteps=len(steps),
            steps=steps,
        )