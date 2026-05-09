"""
tracers/python_tracer.py

Spawns python_agent.py as a completely isolated subprocess rather than
exec()-ing user code inside the FastAPI process.  This means:
  • A crash or MemoryError in user code cannot kill the API server.
  • sys.settrace and resource limits are local to the child process.
  • Each request gets a fresh interpreter state — no cross-request bleed.

Protocol
────────
The child writes newline-delimited JSON to stdout.
Each line is either a step snapshot or the final done sentinel:

    {"step":N, "line":L, "stdout":"...", "stack":{...}, "heap":{...}}
    {"done":true, "runtimeError": null | "..."}
"""

import asyncio
import json
import re
import sys
import tempfile
from pathlib import Path

from models import ExecuteResponse, StepModel, HeapObject, ErrorLocation

# Location of the agent relative to this file: backend/python_agent.py
AGENT_PATH = Path(__file__).resolve().parent.parent / "python_agent.py"


async def run_python(code: str) -> ExecuteResponse:
    with tempfile.TemporaryDirectory(prefix="py_trace_") as tmpdir:
        src_file = Path(tmpdir) / "user_code.py"
        src_file.write_text(code, encoding="utf-8")

        proc = await asyncio.create_subprocess_exec(
            sys.executable, str(AGENT_PATH), str(src_file),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,   
        )

        steps:         list[StepModel]     = []
        errors:        list[ErrorLocation] = []
        runtime_error: str | None          = None

        assert proc.stdout is not None
        async for raw_line in proc.stdout:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            # ── Done sentinel ─────────────────────────────────────────────────
            if obj.get("done"):
                rt = obj.get("runtimeError")
                if rt:
                    # Detect compile-time syntax error reported by the agent
                    m = re.match(r"SyntaxError at line (\d+): (.+)", rt)
                    if m:
                        errors.append(ErrorLocation(
                            line=int(m.group(1)),
                            message=m.group(2),
                        ))
                        await proc.wait()
                        return ExecuteResponse(
                            success=False,
                            message="Syntax error",
                            errors=errors,
                            totalSteps=0,
                            steps=[],
                        )
                    runtime_error = rt

                # sys.settrace fires BEFORE each line executes.
                # Therefore the step for print(...) captures stdout=""
                # because the print hasn't happened yet.
                # finalStdout is sent by python_agent.py after execution.
                final_stdout = obj.get("finalStdout", "")

                if final_stdout and steps:
                    last = steps[-1]
                    steps[-1] = StepModel(
                        step=last.step,
                        currentLine=last.currentLine,
                        stdout=final_stdout,
                        stack=last.stack,
                        heap=last.heap,
                    )

                break

            # ── Step snapshot ─────────────────────────────────────────────────
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
                stdout=obj.get("stdout", ""),
                stack=obj.get("stack", {}),
                heap=heap,
            ))

        await proc.wait()

        return ExecuteResponse(
            success=runtime_error is None,
            message="OK" if runtime_error is None else "Runtime error",
            runtimeError=runtime_error,
            errors=errors,
            totalSteps=len(steps),
            steps=steps,
        )