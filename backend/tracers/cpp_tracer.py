"""
tracers/cpp_tracer.py

Executes C++ code and traces it using GDB's Machine Interface (MI) via pexpect.

Cross-platform notes
─────────────────────
  • Linux   — `prlimit` is available; memory cap applied via the OS command.
  • macOS   — `prlimit` does NOT exist; memory cap applied via Python's
              `resource` module inside a preexec_fn passed to pexpect, and
              GDB is launched directly without the prlimit wrapper.
  • The timeout on pexpect.spawn() acts as the hard execution wall on both.
"""

import asyncio
import platform
import re
import resource
import tempfile
from pathlib import Path

import pexpect

from models import ExecuteResponse, StepModel, HeapObject, ErrorLocation

MAX_STEPS   = 500
MEM_LIMIT   = 256 * 1024 * 1024   # 256 MB address-space cap

_IS_LINUX = platform.system() == "Linux"
_IS_MACOS = platform.system() == "Darwin"


# ── Resource-limit helper (macOS / any non-Linux POSIX) ──────────────────────

def _set_mem_limit():
    """
    Called as preexec_fn before execve on non-Linux platforms.
    Sets the virtual-address-space limit to MEM_LIMIT bytes.
    Silently ignored if the platform doesn't support RLIMIT_AS.
    """
    try:
        resource.setrlimit(resource.RLIMIT_AS, (MEM_LIMIT, MEM_LIMIT))
    except (ValueError, resource.error):
        pass   # macOS may refuse RLIMIT_AS in some sandbox configs — that's ok


# ── GDB output parser ────────────────────────────────────────────────────────

def _parse_gdb_locals(text: str) -> dict:
    """Parse GDB MI -stack-list-variables output into {name: value}."""
    locals_dict: dict[str, str] = {}
    matches = re.findall(r'name="([^"]+)",[^}]*value="([^"]+)"', text)
    for name, value in matches:
        clean_val = value.replace('\\"', '"')
        if value.startswith("0x"):
            locals_dict[name] = f"ref: obj_{value}"
        else:
            locals_dict[name] = clean_val
    return locals_dict


# ── Synchronous trace core ───────────────────────────────────────────────────

def _trace_sync(code: str) -> ExecuteResponse:
    with tempfile.TemporaryDirectory(prefix="cpp_trace_") as tmpdir:
        tmp       = Path(tmpdir)
        src_file  = tmp / "main.cpp"
        exe_file  = tmp / "main.out"
        src_file.write_text(code)

        # ── 1. Compile ────────────────────────────────────────────────────────
        compile_output, returncode = pexpect.run(
            f"g++ -g -O0 -o {exe_file} {src_file}",
            encoding="utf-8",
            withexitstatus=True,
        )
        if returncode != 0 or not exe_file.exists():
            return ExecuteResponse(
                success=False,
                message="Compilation failed",
                runtimeError=compile_output.strip(),
                totalSteps=0,
                steps=[],
            )

        # ── 2. Build GDB command ──────────────────────────────────────────────
        #
        #   Linux  → wrap with prlimit so the address space is capped at the
        #             OS level before GDB even starts.
        #   macOS  → launch GDB directly; memory cap applied via preexec_fn
        #             (set inside pexpect via the env/preexec mechanism below).
        #
        if _IS_LINUX:
            gdb_cmd = (
                f"prlimit --as={MEM_LIMIT} "
                f"gdb -q --interpreter=mi {exe_file}"
            )
            preexec = None
        else:
            # macOS / other POSIX — no prlimit, use Python resource module
            gdb_cmd = f"gdb -q --interpreter=mi {exe_file}"
            preexec = _set_mem_limit

        # ── 3. Launch GDB via pexpect ─────────────────────────────────────────
        steps:         list[StepModel] = []
        runtime_error: str | None      = None
        stdout_buf:    list[str]        = []

        try:
            # pexpect.spawn accepts preexec_fn on POSIX systems
            child = pexpect.spawn(
                gdb_cmd,
                encoding  = "utf-8",
                timeout   = 10,          # per-expect() timeout in seconds
                preexec_fn= preexec,     # None on Linux (handled by prlimit)
            )
        except pexpect.exceptions.ExceptionPexpect as exc:
            return ExecuteResponse(
                success=False,
                message="Failed to launch GDB",
                runtimeError=str(exc),
                totalSteps=0,
                steps=[],
            )

        try:
            # Wait for the MI prompt
            child.expect(r"\(gdb\)", timeout=10)

            # Insert a breakpoint at main() and run
            child.sendline("-break-insert main")
            child.expect(r"\^done", timeout=5)

            child.sendline("-exec-run")

            step_count = 0

            while step_count < MAX_STEPS:
                idx = child.expect(
                    [
                        r'\*stopped,reason="exited-normally"',   # 0 — clean exit
                        r'\*stopped,reason="exited',             # 1 — non-zero exit
                        r'\*stopped',                            # 2 — any other stop (step)
                        pexpect.TIMEOUT,                         # 3
                        pexpect.EOF,                             # 4
                    ],
                    timeout=5,
                )

                if idx in (0, 4):          # normal exit or EOF
                    break
                if idx == 1:               # non-zero exit
                    runtime_error = "Process exited with non-zero status"
                    break
                if idx == 3:               # timeout
                    runtime_error = "Execution timeout or infinite loop"
                    break

                # idx == 2 → stopped at a step
                step_count += 1

                combined = (child.before or "") + (child.after or "")

                # Extract current source line
                line_match = re.search(r'line="(\d+)"', combined)
                line_num   = int(line_match.group(1)) if line_match else 0

                # Collect any program output flushed to the MI console
                output_match = re.findall(r'~"([^"\\]|\\.)*"', combined)
                for raw in output_match:
                    # Strip the surrounding ~"..." MI quoting
                    text = raw[2:-1].replace('\\n', '\n').replace('\\"', '"')
                    stdout_buf.append(text)

                # Fetch local variables
                child.sendline("-stack-list-variables --simple-values")
                try:
                    child.expect(r"\^done", timeout=3)
                    locals_raw  = (child.before or "") + (child.after or "")
                    locals_dict = _parse_gdb_locals(locals_raw)
                except pexpect.TIMEOUT:
                    locals_dict = {}

                # Build a minimal heap from pointer variables
                heap: dict[str, HeapObject] = {}
                for var, val in locals_dict.items():
                    if isinstance(val, str) and val.startswith("ref: "):
                        addr = val.split("obj_")[1]
                        heap[f"obj_{addr}"] = HeapObject(
                            type  = "Pointer",
                            value = f"0x{addr}",
                        )

                steps.append(StepModel(
                    step        = step_count,
                    currentLine = line_num,
                    stdout      = "".join(stdout_buf),
                    stack       = {"main": locals_dict},
                    heap        = heap,
                ))

                # Advance one source line
                child.sendline("-exec-next")

        except pexpect.EOF:
            pass   # GDB exited — normal
        except Exception as exc:
            runtime_error = f"Tracer error: {exc}"
        finally:
            try:
                child.terminate(force=True)
            except Exception:
                pass

        return ExecuteResponse(
            success      = runtime_error is None,
            message      = "OK" if runtime_error is None else "Runtime error",
            runtimeError = runtime_error,
            totalSteps   = len(steps),
            steps        = steps,
        )


# ── Async entry point ─────────────────────────────────────────────────────────

async def run_cpp(code: str) -> ExecuteResponse:
    """Run the synchronous GDB tracer in a thread pool (non-blocking)."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _trace_sync, code)