"""
tracers/java_tracer.py  (fixed)

Key changes vs original
────────────────────────
1.  _read_jvm_output() reads BOTH stdout AND stderr for the JDWP port line.
    JDK 17 writes the port to stderr; JDK 21 writes it to stdout.
    This file now works with either version.

2.  Reduced JVM heap (-Xmx64m / -Xms16m) and forced SerialGC so two JVMs
    can coexist on Render's 512 MB free-tier instance.

3.  Logging added at every major stage so Render logs show exactly where
    execution stalls.

4.  JDWP_STDOUT_TIMEOUT bumped to 25 s for slow cold-start containers.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from models import ExecuteResponse, StepModel, HeapObject, ErrorLocation

log = logging.getLogger(__name__)

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
    if not AGENT_SOURCE.exists():
        raise RuntimeError(f"JvmTraceAgent.java not found at {AGENT_SOURCE}.")
    if (AGENT_CLASS.exists()
            and AGENT_CLASS.stat().st_mtime >= AGENT_SOURCE.stat().st_mtime):
        return
    log.info("Compiling JvmTraceAgent.java ...")
    javac = _find_tool("javac")
    result = subprocess.run(
        [javac, str(AGENT_SOURCE), "-d", str(AGENT_CLASS_DIR)],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Failed to compile JvmTraceAgent.java:\n{result.stderr}"
        )
    log.info("JvmTraceAgent compiled OK")

# ── Patterns ──────────────────────────────────────────────────────────────────
_JAVAC_ERROR_RE  = re.compile(r"^.+?:(\d+):\s+error:\s+(.+)$", re.MULTILINE)
_JDWP_PORT_RE    = re.compile(r"address:\s+(?:[\w.]+:)?(\d+)")

JDWP_STDOUT_TIMEOUT = 25   # seconds — raised for cold containers


def _parse_javac_errors(stderr: str) -> list[ErrorLocation]:
    errs = [
        ErrorLocation(line=int(m.group(1)), message=m.group(2).strip())
        for m in _JAVAC_ERROR_RE.finditer(stderr)
    ]
    return errs or [ErrorLocation(line=0, message=stderr.strip()[:500])]


# ── Combined stdout + stderr reader ──────────────────────────────────────────
#
#   JDK 17  →  JDWP "Listening at address: PORT"  goes to STDERR
#   JDK 21  →  same message goes to STDOUT
#
#   We race both streams so this works with any JDK version.
#
async def _read_jvm_output(
    stdout: asyncio.StreamReader,
    stderr: asyncio.StreamReader,
    port_found: "asyncio.Future[int]",
    stdout_lines: list[str],
) -> None:
    async def drain(stream: asyncio.StreamReader, is_stderr: bool) -> None:
        async for raw in stream:
            line = raw.decode("utf-8", errors="replace")
            if not port_found.done():
                m = _JDWP_PORT_RE.search(line)
                if m:
                    port = int(m.group(1))
                    log.info("JDWP port found on %s: %d",
                             "stderr" if is_stderr else "stdout", port)
                    port_found.set_result(port)
                    continue          # don't add the JDWP banner to output
            if not is_stderr:
                stdout_lines.append(line)

    await asyncio.gather(
        drain(stdout, False),
        drain(stderr, True),
    )


# ── Main entry point ──────────────────────────────────────────────────────────

async def run_java(code: str) -> ExecuteResponse:
    log.info("run_java: starting")

    try:
        _ensure_agent_compiled()
        java  = _find_tool("java")
        javac = _find_tool("javac")
    except RuntimeError as exc:
        log.error("run_java: tool/agent error: %s", exc)
        return ExecuteResponse(
            success=False,
            message=str(exc),
            runtimeError=str(exc),
            totalSteps=0,
            steps=[],
        )

    log.info("run_java: using java=%s", java)

    with tempfile.TemporaryDirectory(prefix="jvm_trace_") as tmpdir:
        tmp = Path(tmpdir)

        m = re.search(r"\bpublic\s+class\s+(\w+)", code)
        class_name = m.group(1) if m else "Main"
        src_file = tmp / f"{class_name}.java"
        src_file.write_text(code)

        # ── Step 1: Compile ───────────────────────────────────────────────────
        log.info("run_java: compiling %s", class_name)
        cp = await asyncio.create_subprocess_exec(
            javac, "-g", str(src_file), "-d", str(tmp),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr_bytes = await cp.communicate()
        if cp.returncode != 0:
            log.warning("run_java: compilation failed")
            return ExecuteResponse(
                success=False,
                message="Compilation failed",
                errors=_parse_javac_errors(stderr_bytes.decode()),
                totalSteps=0,
                steps=[],
            )
        log.info("run_java: compilation OK")

        # ── Step 2: Launch JVM with JDWP ─────────────────────────────────────
        #
        #   -Xmx64m / -Xms16m   keep the user JVM small so the agent JVM
        #                        can also fit within Render's 512 MB RAM.
        #   -XX:+UseSerialGC     avoids spawning multiple GC threads on a
        #                        shared-CPU container (reduces overhead).
        #
        log.info("run_java: launching JVM with JDWP suspend=y ...")
        jvm_proc = await asyncio.create_subprocess_exec(
            java,
            "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0",
            "-Xmx64m",
            "-Xms16m",
            "-XX:+UseSerialGC",
            "-XX:TieredStopAtLevel=1",
            "-cp", str(tmp),
            class_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert jvm_proc.stdout is not None
        assert jvm_proc.stderr is not None

        # ── Step 3: Race stdout vs stderr for JDWP port ───────────────────────
        stdout_lines: list[str] = []
        port_found: asyncio.Future[int] = asyncio.get_event_loop().create_future()

        stdout_task = asyncio.create_task(
            _read_jvm_output(jvm_proc.stdout, jvm_proc.stderr,
                             port_found, stdout_lines)
        )

        try:
            port = await asyncio.wait_for(
                asyncio.shield(port_found), timeout=JDWP_STDOUT_TIMEOUT
            )
        except asyncio.TimeoutError:
            stdout_task.cancel()
            jvm_proc.kill()
            await jvm_proc.wait()
            log.error("run_java: JDWP port not found within %ds", JDWP_STDOUT_TIMEOUT)
            return ExecuteResponse(
                success=False,
                message=(
                    f"JVM did not print a JDWP port within "
                    f"{JDWP_STDOUT_TIMEOUT}s. "
                    "Check that a full JDK (not just JRE) is installed."
                ),
                runtimeError="JDWP port timeout",
                totalSteps=0,
                steps=[],
            )

        log.info("run_java: JDWP port=%d, launching agent ...", port)

        # ── Step 4: Launch JvmTraceAgent ──────────────────────────────────────
        agent_proc = await asyncio.create_subprocess_exec(
            java,
            "-Xmx64m",
            "-Xms16m",
            "-XX:+UseSerialGC",
            "-cp", str(AGENT_CLASS_DIR),
            "JvmTraceAgent", str(port),
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
                log.info("run_java: agent done — steps=%d runtimeError=%s",
                         len(steps), runtime_error)
                break

            await asyncio.sleep(0)

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

        # Surface agent crash when trace is empty
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
            log.error("run_java: %s", runtime_error)

        log.info("run_java: returning %d steps, success=%s",
                 len(steps), runtime_error is None)

        return ExecuteResponse(
            success=runtime_error is None,
            message="OK" if runtime_error is None else "Runtime error",
            runtimeError=runtime_error,
            totalSteps=len(steps),
            steps=steps,
        )
