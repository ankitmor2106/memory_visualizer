"""
python_agent.py — Isolated execution agent for Python code tracing.

Spawned as a subprocess by tracers/python_tracer.py.  Reads user source from
the path given as argv[1], compiles it, traces every line via sys.settrace(),
and emits newline-delimited JSON to stdout.

Each step line:
    {"step": N, "line": L, "stdout": "...", "stack": {...}, "heap": {...}}

Final sentinel:
    {"done": true, "runtimeError": null}
    {"done": true, "runtimeError": "..."}

Security model
──────────────
  • Entirely separate OS process — a tracer bug or malicious code cannot
    corrupt the FastAPI server's address space.
  • __builtins__ replaced with a strict allowlist: no open(), no __import__,
    no exec/eval, no breakpoint, no compile.
  • resource.RLIMIT_AS caps virtual address space to 256 MB.
  • resource.RLIMIT_NOFILE caps open file-descriptors to 32.
  • sys.settrace is always restored in the finally block so the parent
    interpreter is not contaminated when this process is reused.
"""

import sys
import json
import io
import resource
import contextlib
import traceback as _tb

MAX_STEPS     = 500
MAX_REPR_LEN  = 200
DEPTH_LIMIT   = 3        # heap graph traversal depth

PRIMITIVES = (int, float, bool, str, bytes, type(None))

# ── Safe builtins whitelist ────────────────────────────────────────────────────
_SAFE_BUILTINS_NAMES = {
    "abs", "all", "any", "bin", "bool", "bytearray", "bytes", "callable",
    "chr", "complex", "dict", "dir", "divmod", "enumerate", "filter",
    "float", "format", "frozenset", "getattr", "hasattr", "hash",
    "hex", "id", "int", "isinstance", "issubclass", "iter", "len", "list",
    "map", "max", "min", "next", "object", "oct", "ord", "pow", "print",
    "property", "range", "repr", "reversed", "round", "set", "setattr",
    "slice", "sorted", "staticmethod", "str", "sum", "super", "tuple",
    "type", "vars", "zip",
    "True", "False", "None","__build_class__","__name__",
    # Common exceptions
    "Exception", "BaseException", "ValueError", "TypeError", "KeyError",
    "IndexError", "AttributeError", "RuntimeError", "StopIteration",
    "NotImplementedError", "ZeroDivisionError", "OverflowError",
    "MemoryError", "OSError", "IOError", "FileNotFoundError",
    "PermissionError", "ArithmeticError", "LookupError", "NameError",
    "AssertionError", "RecursionError", "GeneratorExit", "SystemExit",
}


def _build_safe_globals() -> dict:
    import builtins as _bi
    bi = vars(_bi)
    safe = {k: bi[k] for k in _SAFE_BUILTINS_NAMES if k in bi}
    return {
    "__builtins__": safe,
    "__name__": "__user__",
}


# ── Value encoder ─────────────────────────────────────────────────────────────

def _safe_repr(val) -> str:
    try:
        r = repr(val)
    except Exception:
        r = "<repr error>"
    return (r[:MAX_REPR_LEN] + "…") if len(r) > MAX_REPR_LEN else r


def _obj_id(val) -> str:
    return f"obj_{id(val)}"


def _encode(val, heap: dict, depth: int = 0):
    """Return JSON-safe encoding; place complex objects in heap."""
    if isinstance(val, PRIMITIVES):
        return _safe_repr(val)

    oid = _obj_id(val)
    if oid in heap:
        return f"ref: {oid}"

    # Prevent infinite recursion via placeholder
    heap[oid] = {"type": type(val).__name__, "value": "…", "fields": {}}

    if depth >= DEPTH_LIMIT:
        return f"ref: {oid}"

    if isinstance(val, list):
        fields = {str(i): _encode(v, heap, depth + 1) for i, v in enumerate(val)}
        heap[oid] = {"type": "list", "value": f"[{len(val)} items]", "fields": fields}

    elif isinstance(val, dict):
        fields = {_safe_repr(k): _encode(v, heap, depth + 1) for k, v in val.items()}
        heap[oid] = {"type": "dict", "value": f"{{{len(val)} entries}}", "fields": fields}

    elif isinstance(val, (set, frozenset)):
        fields = {str(i): _encode(v, heap, depth + 1) for i, v in enumerate(val)}
        heap[oid] = {
            "type": type(val).__name__,
            "value": f"{{{len(val)} items}}",
            "fields": fields,
        }

    elif isinstance(val, tuple):
        fields = {str(i): _encode(v, heap, depth + 1) for i, v in enumerate(val)}
        heap[oid] = {"type": "tuple", "value": f"({len(val)} items)", "fields": fields}

    else:
        try:
            obj_dict = {k: _encode(v, heap, depth + 1) for k, v in vars(val).items()}
        except TypeError:
            obj_dict = {}
        heap[oid] = {
            "type": type(val).__qualname__,
            "value": _safe_repr(val),
            "fields": obj_dict,
        }

    return f"ref: {oid}"


# ── Emit helper ───────────────────────────────────────────────────────────────

# ── Emit helper ───────────────────────────────────────────────────────────────

def _emit(obj: dict) -> None:
    # IMPORTANT: use sys.__stdout__ (the real fd-1 pipe), NOT sys.stdout.
    # redirect_stdout swaps sys.stdout to StringIO while capturing user prints.
    # Using sys.stdout here would swallow tracer JSON messages.
    sys.__stdout__.write(json.dumps(obj, default=str) + "\n")
    sys.__stdout__.flush()


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if len(sys.argv) < 2:
        _emit({"done": True, "runtimeError": "python_agent: no source file argument"})
        sys.exit(1)

    src_path = sys.argv[1]
    try:
        with open(src_path, "r", encoding="utf-8") as fh:
            code = fh.read()
    except Exception as exc:
        _emit({"done": True, "runtimeError": f"python_agent: cannot read source: {exc}"})
        sys.exit(1)

    # ── Apply resource limits ─────────────────────────────────────────────────
    for limit, value in (
        (resource.RLIMIT_AS,    (256 * 1024 * 1024, resource.RLIM_INFINITY)),
        (resource.RLIMIT_NOFILE, (32, 32)),
    ):
        try:
            resource.setrlimit(limit, value)
        except Exception:
            pass   # Non-fatal; some platforms don't support all limits

    # ── Compile ───────────────────────────────────────────────────────────────
    try:
        bytecode = compile(code, "<user>", "exec")
    except SyntaxError as exc:
        _emit({
            "done": True,
            "runtimeError": f"SyntaxError at line {exc.lineno}: {exc.msg}",
        })
        return

    # ── Tracer state ──────────────────────────────────────────────────────────
    step_count  = [0]
    stdout_buf  = io.StringIO()
    frame_names: dict[int, str] = {}

    def _tracer(frame, event, arg):
        if event not in ("line", "call", "return"):
            return _tracer

        if frame.f_code.co_filename != "<user>":
            return _tracer  # skip stdlib / internal frames

        fid  = id(frame)
        qual = frame.f_code.co_qualname or frame.f_code.co_name or "<module>"
        frame_names[fid] = qual

        if event == "return":
            frame_names.pop(fid, None)
            return _tracer

        # Check limit before doing any work
        if step_count[0] >= MAX_STEPS:
            raise RuntimeError("_TraceLimitReached_")

        # ── Snapshot ──────────────────────────────────────────────────────────
        heap: dict       = {}
        stack_snap: dict = {}

        cur = frame
        while cur is not None:
            if cur.f_code.co_filename == "<user>":
                fn    = frame_names.get(id(cur), cur.f_code.co_name)
                local = {}
                for var, val in cur.f_locals.items():
                    if not var.startswith("__"):
                        local[var] = _encode(val, heap)
                stack_snap[fn] = local
            cur = cur.f_back

        step_count[0] += 1
        _emit({
            "step":   step_count[0],
            "line":   frame.f_lineno,
            "stdout": stdout_buf.getvalue(),
            "stack":  stack_snap,
            "heap":   heap,
        })
        return _tracer

    # ── Execute ───────────────────────────────────────────────────────────────
    gbl       = _build_safe_globals()
    old_trace = sys.gettrace()
    runtime_error: str | None = None

    try:
        with contextlib.redirect_stdout(stdout_buf):
            sys.settrace(_tracer)
            exec(bytecode, gbl)  # noqa: S102 — intentional sandboxed exec
    except RuntimeError as exc:
        if "_TraceLimitReached_" in str(exc):
            runtime_error = "ExecutionLimitExceeded: Possible infinite loop detected."
        else:
            runtime_error = _tb.format_exc()
    except Exception:
        runtime_error = _tb.format_exc()
    finally:
        sys.settrace(old_trace)

     # finalStdout contains the fully captured stdout AFTER execution.
    # The last trace step happens BEFORE print() executes,
    # so python_tracer.py backfills the final step using this value.
    _emit({
        "done": True,
        "runtimeError": runtime_error,
        "finalStdout": stdout_buf.getvalue(),
    })


if __name__ == "__main__":
    main()