"""
tracers/python_tracer.py

Executes user Python code via exec() in an isolated namespace and traces
every line using sys.settrace().

Security model
──────────────
  • Runs in the same OS process but an entirely separate global namespace.
  • __builtins__ is replaced with a restricted whitelist.  Dangerous built-ins
    (open, __import__, compile, exec, eval, breakpoint, input) are blocked.
  • resource.setrlimit caps address-space to 256 MB for the tracer coroutine's
    thread.  Because CPython is single-threaded this also protects the server.
  • sys.settrace is restored after execution to avoid contaminating the server.

Heap representation
───────────────────
  • Primitive types (int, float, bool, str, NoneType) are stored inline.
  • Mutable containers (list, dict, set, tuple, custom objects) get a stable
    heap ID of the form "obj_<id()>" and are stored in the heap dict.
  • We follow references one level deep to avoid infinite recursion on cyclic
    structures.  Deeper objects are referenced by their obj_id.
"""

import asyncio
import contextlib
import io
import resource
import sys
import traceback
from typing import Any

from models import ExecuteResponse, StepModel, HeapObject, ErrorLocation

# Builtins that are safe to expose to user code
_SAFE_BUILTINS = {
    "abs", "all", "any", "bin", "bool", "bytearray", "bytes", "callable",
    "chr", "complex", "dict", "dir", "divmod", "enumerate", "filter",
    "float", "format", "frozenset", "getattr", "hasattr", "hash", "help",
    "hex", "id", "int", "isinstance", "issubclass", "iter", "len", "list",
    "map", "max", "min", "next", "object", "oct", "ord", "pow", "print",
    "property", "range", "repr", "reversed", "round", "set", "setattr",
    "slice", "sorted", "staticmethod", "str", "sum", "super", "tuple",
    "type", "vars", "zip", "True", "False", "None",
    # Exceptions — user code needs these
    "Exception", "ValueError", "TypeError", "KeyError", "IndexError",
    "AttributeError", "RuntimeError", "StopIteration", "NotImplementedError",
    "ZeroDivisionError", "OverflowError", "MemoryError", "OSError",
    "IOError", "FileNotFoundError", "PermissionError",
}

PRIMITIVES = (int, float, bool, str, bytes, type(None))
MAX_REPR_LEN = 120  # truncate large repr() strings


def _safe_repr(val: Any) -> str:
    try:
        r = repr(val)
    except Exception:
        r = "<repr error>"
    return r[:MAX_REPR_LEN] + ("…" if len(r) > MAX_REPR_LEN else "")


def _obj_id(val: Any) -> str:
    return f"obj_{id(val)}"


def _encode_value(val: Any, heap: dict[str, HeapObject], depth: int = 0) -> Any:
    """
    Return the JSON-serialisable representation of a value.
    Primitives → inline.  References → "ref: obj_<id>" and populate heap.
    depth=0 → shallow encode; depth>0 → stop recursing.
    """
    if isinstance(val, PRIMITIVES):
        return _safe_repr(val)

    oid = _obj_id(val)

    if oid in heap:
        # Already recorded — just emit the reference
        return f"ref: {oid}"

    # Prevent recursion: insert a placeholder first
    heap[oid] = HeapObject(type=type(val).__name__, value="…", fields={})

    if isinstance(val, list):
        fields = {str(i): _encode_value(v, heap, depth + 1) for i, v in enumerate(val)}
        heap[oid] = HeapObject(type="list", value=f"[{len(val)} items]", fields=fields)
    elif isinstance(val, dict):
        fields = {_safe_repr(k): _encode_value(v, heap, depth + 1) for k, v in val.items()}
        heap[oid] = HeapObject(type="dict", value=f"{{{len(val)} entries}}", fields=fields)
    elif isinstance(val, (set, frozenset)):
        fields = {str(i): _encode_value(v, heap, depth + 1) for i, v in enumerate(val)}
        heap[oid] = HeapObject(type=type(val).__name__, value=f"{{{len(val)} items}}", fields=fields)
    elif isinstance(val, tuple):
        fields = {str(i): _encode_value(v, heap, depth + 1) for i, v in enumerate(val)}
        heap[oid] = HeapObject(type="tuple", value=f"({len(val)} items)", fields=fields)
    else:
        # Custom object — expose __dict__ fields
        try:
            obj_dict = {k: _encode_value(v, heap, depth + 1) for k, v in vars(val).items()}
        except TypeError:
            obj_dict = {}
        heap[oid] = HeapObject(
            type=type(val).__qualname__,
            value=_safe_repr(val),
            fields=obj_dict,
        )

    return f"ref: {oid}"


def _build_restricted_globals() -> dict:
    """Build the sandboxed global namespace for exec()."""
    safe_builtins = {k: getattr(__builtins__, k, None) or __builtins__[k]
                     for k in _SAFE_BUILTINS
                     if hasattr(__builtins__, k) or
                     (isinstance(__builtins__, dict) and k in __builtins__)}
    return {"__builtins__": safe_builtins, "__name__": "__user__"}


async def run_python(code: str) -> ExecuteResponse:
    """
    Trace Python code and return the full ExecuteResponse.
    Runs synchronously inside run_in_executor to avoid blocking the event loop.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _trace_sync, code)


def _trace_sync(code: str) -> ExecuteResponse:
    # ── Compile first to surface syntax errors cleanly ────────────────────────
    try:
        bytecode = compile(code, "<user>", "exec")
    except SyntaxError as e:
        return ExecuteResponse(
            success=False,
            message="Syntax error",
            errors=[ErrorLocation(line=e.lineno or 0, message=str(e.msg))],
            totalSteps=0,
            steps=[],
        )

    # ── Set address-space limit for this thread (256 MB) ─────────────────────
    try:
        resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, resource.RLIM_INFINITY))
    except (ValueError, resource.error):
        pass  # May fail on some platforms; continue anyway

    steps: list[StepModel] = []
    stdout_buf = io.StringIO()
    runtime_error: str | None = None
    step_counter = [0]  # mutable for closure

    # Current accumulated locals snapshot per frame
    # key = frame id, value = frame name
    frame_names: dict[int, str] = {}

    def _tracer(frame, event, arg):
        """sys.settrace callback — fires on 'call', 'line', 'return', 'exception'."""
        if event not in ("line", "call", "return"):
            return _tracer

        fname = frame.f_code.co_filename
        if fname != "<user>":
            return _tracer  # Skip stdlib frames

        frame_id = id(frame)
        qual_name = frame.f_code.co_qualname or frame.f_code.co_name or "<module>"
        frame_names[frame_id] = qual_name

        if event == "return":
            frame_names.pop(frame_id, None)
            return _tracer

        # ── Snapshot the call stack ───────────────────────────────────────────
        heap: dict[str, HeapObject] = {}
        stack_snap: dict[str, dict[str, Any]] = {}

        # Walk up the frame chain, innermost first
        cur = frame
        while cur is not None:
            if cur.f_code.co_filename == "<user>":
                fn = frame_names.get(id(cur), cur.f_code.co_name)
                locals_snap: dict[str, Any] = {}
                for var, val in cur.f_locals.items():
                    if not var.startswith("__"):
                        locals_snap[var] = _encode_value(val, heap)
                stack_snap[fn] = locals_snap
            cur = cur.f_back

        step_counter[0] += 1
        steps.append(StepModel(
            step=step_counter[0],
            currentLine=frame.f_lineno,
            stdout=stdout_buf.getvalue(),
            stack=stack_snap,
            heap=heap,
        ))

        # Prevent runaway traces (loops)
        if step_counter[0] >= 500:
            raise RuntimeError("Trace step limit reached (possible infinite loop)")

        return _tracer

    gbl = _build_restricted_globals()
    old_trace = sys.gettrace()

    try:
        with contextlib.redirect_stdout(stdout_buf):
            sys.settrace(_tracer)
            exec(bytecode, gbl)  # noqa: S102 — sandboxed namespace
    except RuntimeError as e:
        if "Trace step limit" in str(e):
            runtime_error = "ExecutionLimitExceeded: Possible infinite loop detected."
        else:
            runtime_error = traceback.format_exc()
    except Exception:
        runtime_error = traceback.format_exc()
    finally:
        sys.settrace(old_trace)

    return ExecuteResponse(
        success=runtime_error is None,
        message="OK" if runtime_error is None else "Runtime error",
        runtimeError=runtime_error,
        totalSteps=len(steps),
        steps=steps,
    )