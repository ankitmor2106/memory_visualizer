"""
tracers/cpp_tracer.py

Executes C++ code and traces it using GDB's Machine Interface (MI) via pexpect.
"""

import asyncio
import re
import tempfile
from pathlib import Path
from typing import Any
import pexpect

from models import ExecuteResponse, StepModel, HeapObject, ErrorLocation

MAX_STEPS = 500

def _parse_gdb_locals(locals_str: str) -> dict:
    """Parses GDB MI variable output string into a dictionary."""
    locals_dict = {}
    # Simple regex to extract name/value pairs from GDB MI format
    matches = re.findall(r'name="([^"]+)",[^}]*value="([^"]+)"', locals_str)
    for name, value in matches:
        # Check if value is a pointer/address
        if value.startswith("0x"):
            locals_dict[name] = f"ref: obj_{value}"
        else:
            locals_dict[name] = value.replace("\\\"", "\"")
    return locals_dict

def _trace_sync(code: str) -> ExecuteResponse:
    with tempfile.TemporaryDirectory(prefix="cpp_trace_") as tmpdir:
        tmp = Path(tmpdir)
        src_file = tmp / "main.cpp"
        exe_file = tmp / "main.out"
        src_file.write_text(code)

        # 1. Compile
        compile_proc = pexpect.run(
            f"g++ -g -O0 {src_file} -o {exe_file}",
            encoding='utf-8'
        )
        if not exe_file.exists():
            return ExecuteResponse(
                success=False,
                message="Compilation failed",
                runtimeError=compile_proc,
                totalSteps=0,
                steps=[]
            )

        # 2. Trace with GDB
        child = pexpect.spawn(f"gdb -q -mi {exe_file}", encoding='utf-8', timeout=2)
        steps = []
        runtime_error = None
        stdout_buf = []
        
        try:
            child.sendline("-break-insert main")
            child.expect(r"\^done")
            
            child.sendline("-exec-run")
            
            step_count = 0
            while step_count < MAX_STEPS:
                idx = child.expect([r"\*stopped,reason=\"exited-normally\"", r"\*stopped", pexpect.TIMEOUT, pexpect.EOF])
                
                # Exited
                if idx == 0 or idx == 3:
                    break
                # Timeout
                if idx == 2:
                    runtime_error = "Execution Limit Exceeded or Infinite Loop"
                    break

                step_count += 1
                
                # Extract line number
                line_match = re.search(r'line="(\d+)"', child.before + child.after)
                line_num = int(line_match.group(1)) if line_match else 0
                
                # Fetch local variables
                child.sendline("-stack-list-variables --simple-values")
                child.expect(r"\^done")
                locals_dict = _parse_gdb_locals(child.before)

                heap: dict[str, HeapObject] = {}
                for var, val in locals_dict.items():
                    if val.startswith("ref: "):
                        addr = val.split("obj_")[1]
                        heap[f"obj_{addr}"] = HeapObject(
                            type="Pointer",
                            value=f"Memory at {addr}"
                        )

                steps.append(StepModel(
                    step=step_count,
                    currentLine=line_num,
                    stdout="".join(stdout_buf), # Note: GDB MI stdout capturing is complex, keeping simple for now
                    stack={"main": locals_dict},
                    heap=heap
                ))

                # Step to next line
                child.sendline("-exec-step")

        except Exception as e:
            runtime_error = f"Tracer Error: {str(e)}"
        
        finally:
            child.terminate(force=True)

        return ExecuteResponse(
            success=runtime_error is None,
            message="OK" if runtime_error is None else "Runtime Error",
            runtimeError=runtime_error,
            totalSteps=len(steps),
            steps=steps
        )

async def run_cpp(code: str) -> ExecuteResponse:
    """Run pexpect synchronously in a thread pool to avoid blocking FastAPI"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _trace_sync, code)