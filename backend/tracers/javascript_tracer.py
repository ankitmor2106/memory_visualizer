import asyncio
import json
import re
import tempfile
from pathlib import Path
from typing import Any

import websockets

from models import ExecuteResponse, StepModel, HeapObject

MAX_STEPS = 500


async def run_javascript(code: str) -> ExecuteResponse:
    with tempfile.TemporaryDirectory(prefix="js_trace_") as tmpdir:

        src_file = Path(tmpdir) / "main.js"
        src_file.write_text(code, encoding="utf-8")

        proc = await asyncio.create_subprocess_exec(
            "node",
            "--inspect-brk=0",
            str(src_file),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # ── Get websocket inspector URL ──────────────────────────────
        ws_url = None

        assert proc.stderr is not None

        async for raw in proc.stderr:
            text = raw.decode(errors="replace")

            m = re.search(r"ws://127\.0\.0\.1:\d+/[0-9a-f\-]+", text)

            if m:
                ws_url = m.group(0)
                break

        if not ws_url:
            return ExecuteResponse(
                success=False,
                message="Failed to start Node inspector",
                runtimeError="No websocket URL found",
                totalSteps=0,
                steps=[],
            )

        steps: list[StepModel] = []
        runtime_error: str | None = None
        stdout_lines: list[str] = []

        # ── Read actual Node stdout directly ─────────────────────────
        async def read_stdout():
            assert proc.stdout is not None

            async for raw in proc.stdout:
                stdout_lines.append(
                    raw.decode(errors="replace")
                )

        stdout_task = asyncio.create_task(read_stdout())

        try:
            async with websockets.connect(
                ws_url,
                ping_timeout=None,
            ) as ws:

                response_futures = {}
                event_queue = asyncio.Queue()

                # ── Message pump ─────────────────────────────────────
                async def pump():
                    try:
                        async for raw in ws:
                            msg = json.loads(raw)

                            if "id" in msg:
                                fut = response_futures.pop(
                                    msg["id"],
                                    None,
                                )

                                if fut and not fut.done():
                                    fut.set_result(msg)

                            elif "method" in msg:
                                await event_queue.put(msg)

                    except Exception:
                        pass

                pump_task = asyncio.create_task(pump())

                msg_id = [1]

                async def send(method, params=None):

                    mid = msg_id[0]
                    msg_id[0] += 1

                    fut = asyncio.get_event_loop().create_future()

                    response_futures[mid] = fut

                    await ws.send(json.dumps({
                        "id": mid,
                        "method": method,
                        "params": params or {},
                    }))

                    return await asyncio.wait_for(
                        fut,
                        timeout=5,
                    )

                # ── Enable runtime/debugger ──────────────────────────
                await send("Runtime.enable")
                await send("Debugger.enable")
                await send("Runtime.runIfWaitingForDebugger")

                step_count = 0

                while True:

                    try:
                        event = await asyncio.wait_for(
                            event_queue.get(),
                            timeout=4,
                        )
                    except asyncio.TimeoutError:
                        break

                    method = event.get("method", "")
                    params = event.get("params", {})

                    # ── Runtime exception ────────────────────────────
                    if method == "Runtime.exceptionThrown":

                        detail = params.get(
                            "exceptionDetails",
                            {},
                        )

                        runtime_error = (
                            detail.get(
                                "exception",
                                {},
                            ).get("description")
                            or detail.get(
                                "text",
                                "Unknown JS error",
                            )
                        )

                        break

                    # Ignore non-pause events
                    if method != "Debugger.paused":
                        continue

                    frames = params.get("callFrames", [])

                    if not frames:
                        await send("Debugger.stepOver")
                        continue

                    top = frames[0]

                    url = top.get("url", "")

                    # ── Skip Node/V8 internal files ─────────────────
                    if (
                        url.startswith("node:")
                        or "internal/" in url
                        or "bootstrap" in url
                    ):
                        await send("Debugger.stepOver")
                        continue

                    step_count += 1

                    if step_count > MAX_STEPS:
                        runtime_error = (
                            "ExecutionLimitExceeded: "
                            "Possible infinite loop."
                        )
                        break

                    line_num = (
                        top.get(
                            "location",
                            {},
                        ).get(
                            "lineNumber",
                            0,
                        ) + 1
                    )

                    func_name = (
                        top.get("functionName")
                        or "<anonymous>"
                    )

                    locals_dict: dict[str, Any] = {}
                    heap: dict[str, HeapObject] = {}

                    # ── Extract locals ──────────────────────────────
                    scope_chain = top.get(
                        "scopeChain",
                        [],
                    )

                    local_scope = next(
                        (
                            s for s in scope_chain
                            if s["type"] == "local"
                        ),
                        None,
                    )

                    if local_scope:

                        obj_id = local_scope[
                            "object"
                        ].get("objectId")

                        if obj_id:

                            try:
                                resp = await send(
                                    "Runtime.getProperties",
                                    {
                                        "objectId": obj_id,
                                        "ownProperties": True,
                                    },
                                )

                                props = (
                                    resp.get(
                                        "result",
                                        {},
                                    ).get(
                                        "result",
                                        [],
                                    )
                                )

                                for prop in props:

                                    pname = prop["name"]

                                    val_obj = prop.get(
                                        "value",
                                        {},
                                    )

                                    vtype = val_obj.get(
                                        "type",
                                        "undefined",
                                    )

                                    if vtype in (
                                        "number",
                                        "string",
                                        "boolean",
                                        "undefined",
                                        "bigint",
                                    ):

                                        locals_dict[pname] = str(
                                            val_obj.get(
                                                "value",
                                                vtype,
                                            )
                                        )

                                    elif vtype == "object":

                                        subtype = val_obj.get(
                                            "subtype",
                                            "object",
                                        )

                                        if subtype == "null":
                                            locals_dict[pname] = "null"

                                        else:

                                            oid = (
                                                "obj_"
                                                + val_obj.get(
                                                    "objectId",
                                                    "?",
                                                )
                                            )

                                            locals_dict[pname] = (
                                                f"ref: {oid}"
                                            )

                                            heap[oid] = HeapObject(
                                                type=val_obj.get(
                                                    "className",
                                                    subtype,
                                                ),
                                                value=val_obj.get(
                                                    "description",
                                                    "",
                                                ),
                                            )

                                    elif vtype == "function":
                                        locals_dict[pname] = "ƒ()"

                            except Exception:
                                pass

                    # ── Snapshot ────────────────────────────────────
                    steps.append(StepModel(
                        step=step_count,
                        currentLine=line_num,
                        stdout="".join(stdout_lines),
                        stack={
                            func_name: locals_dict
                        },
                        heap=heap,
                    ))

                    # IMPORTANT:
                    # stepOver avoids entering Node internals
                    await send("Debugger.stepOver")

                # ── Final stdout patch ─────────────────────────────
                await asyncio.sleep(0.2)

                if steps:

                    last = steps[-1]

                    steps[-1] = StepModel(
                        step=last.step,
                        currentLine=last.currentLine,
                        stdout="".join(stdout_lines),
                        stack=last.stack,
                        heap=last.heap,
                    )

                pump_task.cancel()

        except Exception as exc:
            runtime_error = str(exc)

        finally:

            stdout_task.cancel()

            try:
                proc.kill()
            except Exception:
                pass

            await proc.wait()

        return ExecuteResponse(
            success=runtime_error is None,
            message=(
                "OK"
                if runtime_error is None
                else "Runtime error"
            ),
            runtimeError=runtime_error,
            totalSteps=len(steps),
            steps=steps,
        )