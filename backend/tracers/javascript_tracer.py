"""
tracers/javascript_tracer.py

Executes JavaScript via Node.js using the V8 Inspector Protocol (Chrome DevTools Protocol - CDP).
"""

import asyncio
import json
import re
import tempfile
import traceback
from pathlib import Path
from typing import Any
import websockets

from models import ExecuteResponse, StepModel, HeapObject, ErrorLocation

MAX_STEPS = 500

async def run_javascript(code: str) -> ExecuteResponse:
    with tempfile.TemporaryDirectory(prefix="js_trace_") as tmpdir:
        tmp = Path(tmpdir)
        src_file = tmp / "main.js"
        src_file.write_text(code)

        # Launch node paused on the first line
        proc = await asyncio.create_subprocess_exec(
            "node", f"--inspect-brk=0", str(src_file),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        ws_url = None
        stderr_lines = []
        
        # Read stderr to find the WebSocket URL
        assert proc.stderr is not None
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            line_str = line.decode('utf-8')
            stderr_lines.append(line_str)
            match = re.search(r"ws://127\.0\.0\.1:\d+/[0-9a-f-]+", line_str)
            if match:
                ws_url = match.group(0)
                break

        if not ws_url:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            return ExecuteResponse(
                success=False,
                message="Syntax Error or failed to start Node.js debugger",
                runtimeError="".join(stderr_lines),
                totalSteps=0,
                steps=[]
            )

        steps: list[StepModel] = []
        runtime_error = None
        stdout_buf = []

        try:
            async with websockets.connect(ws_url, ping_timeout=None) as ws:
                msg_id = 1
                
                async def send(method: str, params: dict = None):
                    nonlocal msg_id
                    req = {"id": msg_id, "method": method, "params": params or {}}
                    await ws.send(json.dumps(req))
                    msg_id += 1
                    return req["id"]

                await send("Runtime.enable")
                await send("Debugger.enable")
                await send("Runtime.runIfWaitingForDebugger")

                step_count = 0
                
                while True:
                    try:
                        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=2.0))
                    except asyncio.TimeoutError:
                        break

                    # Capture console.log
                    if msg.get("method") == "Runtime.consoleAPICalled":
                        args = msg["params"]["args"]
                        texts = [a.get("value", a.get("description", "")) for a in args]
                        stdout_buf.append(" ".join(str(t) for t in texts))

                    # Process stopped at a breakpoint / step
                    elif msg.get("method") == "Debugger.paused":
                        step_count += 1
                        if step_count > MAX_STEPS:
                            runtime_error = "ExecutionLimitExceeded: Possible infinite loop."
                            break

                        frames = msg["params"]["callFrames"]
                        if not frames:
                            await send("Debugger.stepInto")
                            continue

                        top_frame = frames[0]
                        line_num = top_frame["location"]["lineNumber"] + 1
                        func_name = top_frame["functionName"] or "main"

                        stack_snap = {}
                        heap: dict[str, HeapObject] = {}

                        # Simplified scope extraction (Locals only for speed)
                        scope_chain = top_frame.get("scopeChain", [])
                        locals_scope = next((s for s in scope_chain if s["type"] == "local"), None)
                        
                        if locals_scope:
                            obj_id = locals_scope["object"]["objectId"]
                            await send("Runtime.getProperties", {"objectId": obj_id, "ownProperties": True})
                            
                            # Wait for properties response
                            prop_msg = json.loads(await ws.recv())
                            while prop_msg.get("id") != msg_id - 1:
                                prop_msg = json.loads(await ws.recv())

                            locals_dict = {}
                            for prop in prop_msg.get("result", {}).get("result", []):
                                name = prop["name"]
                                val_obj = prop.get("value", {})
                                v_type = val_obj.get("type", "undefined")
                                
                                if v_type in ["number", "string", "boolean", "undefined"]:
                                    locals_dict[name] = str(val_obj.get("value", v_type))
                                elif v_type == "object":
                                    subtype = val_obj.get("subtype", "object")
                                    if subtype == "null":
                                        locals_dict[name] = "null"
                                    else:
                                        target_id = f"obj_{val_obj.get('objectId', 'unknown')}"
                                        locals_dict[name] = f"ref: {target_id}"
                                        # Basic heap representation
                                        heap[target_id] = HeapObject(
                                            type=subtype.capitalize(),
                                            value=val_obj.get("description", "Object")
                                        )
                            stack_snap[func_name] = locals_dict

                        steps.append(StepModel(
                            step=step_count,
                            currentLine=line_num,
                            stdout="\n".join(stdout_buf),
                            stack=stack_snap,
                            heap=heap
                        ))

                        await send("Debugger.stepInto")

                    elif msg.get("method") == "Runtime.exceptionThrown":
                        details = msg["params"]["exceptionDetails"]
                        runtime_error = details.get("exception", {}).get("description", "Unknown error")
                        break
                    
                    elif msg.get("method") == "Inspector.detached":
                        break

        except Exception as e:
            runtime_error = f"Tracer Error: {str(e)}"
        
        finally:
            try:
                proc.kill()
            except ProcessLookupError:
                pass

        return ExecuteResponse(
            success=runtime_error is None,
            message="OK" if runtime_error is None else "Runtime Error",
            runtimeError=runtime_error,
            totalSteps=len(steps),
            steps=steps
        )