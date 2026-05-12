"""
tracers/cpp_tracer.py  (v2 — STL-aware varobj inspector)

What's new vs v1
────────────────
1.  GDB varobj API  (-var-create / -var-list-children) replaces the
    fragile single-regex over -stack-list-variables.  Every local
    variable is now inspected through GDB's own type system, so
    std::vector, std::map, std::string, std::pair, std::array,
    raw arrays, structs, nested objects and raw pointers all work.

2.  GDB pretty-printers are enabled at startup
    (set auto-load safe-path / + set print pretty on).
    When libstdc++ pretty-printers are installed, STL containers
    expose logical children ([0],[1],…) instead of _M_impl noise.
    We also apply a hard filter that drops _M_* / __* / _Rb_*
    children even if pretty-printers are absent.

3.  All user-code stack frames are captured, not just "main".
    Recursive helpers, member functions and lambdas all appear
    in the Call Stack panel.

4.  Stepping changed to -exec-step (step-into) so function calls
    are traced. When the tracer lands in a non-user file (STL /
    libc header) it immediately issues -exec-finish to return to
    user code, bounded by MAX_FINISH_ITERS.

5.  Stdout capture fixed: program output appears as @"..." in GDB
    MI, not ~"..." (GDB's own console). Both patterns now collected.

6.  Compiler flags hardened: -std=c++17 -g3 -O0 -fno-omit-frame-pointer.

Cross-platform notes
────────────────────
  Linux  — prlimit wraps GDB so the AS cap is applied OS-side.
  macOS  — resource.setrlimit applied via preexec_fn; GDB launched directly.
"""

import asyncio
import platform
import re
import resource
import tempfile
from pathlib import Path

import pexpect

from models import ExecuteResponse, StepModel, HeapObject, ErrorLocation

# ── Constants ─────────────────────────────────────────────────────────────────
MAX_STEPS       = 500
MEM_LIMIT       = 256 * 1024 * 1024   # 256 MB virtual address cap
DEPTH_LIMIT     = 3                   # heap object graph depth
MAX_FIELDS      = 64                  # max children shown per heap object
MAX_FINISH_ITERS = 8                  # consecutive -exec-finish before giving up

_IS_LINUX = platform.system() == "Linux"

# Monotonically-increasing varobj name counter (unique within each GDB session)
_VCOUNTER: list[int] = [0]


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — Platform / resource helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _set_mem_limit() -> None:
    """Called as preexec_fn on macOS / non-Linux POSIX."""
    try:
        resource.setrlimit(resource.RLIMIT_AS, (MEM_LIMIT, MEM_LIMIT))
    except (ValueError, resource.error):
        pass


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — GDB MI protocol helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _gdb_send(child: pexpect.spawn, cmd: str, timeout: float = 4.0) -> str:
    """
    Send one GDB/MI command and collect output up to the next
    ^done, ^error, or ^exit record.  Returns the raw output string.
    Returns '' on timeout or EOF.
    """
    child.sendline(cmd)
    try:
        child.expect([r'\^done', r'\^error', r'\^exit'], timeout=timeout)
        return (child.before or "") + (child.after or "")
    except (pexpect.TIMEOUT, pexpect.EOF):
        return ""


# Pattern for one double-quoted GDB MI string value (handles \" escapes)
_MI_QUOTED = r'"((?:[^"\\]|\\.)*)"'


def _mi_str(text: str, key: str) -> str:
    """
    Extract the value of  key="..."  from a GDB MI response line.
    Returns '' when the key is absent.
    """
    m = re.search(rf'\b{re.escape(key)}={_MI_QUOTED}', text)
    if not m:
        return ""
    raw = m.group(1)
    return (
        raw.replace('\\"', '"')
           .replace('\\\\', '\\')
           .replace('\\n', '\n')
           .replace('\\t', '\t')
    )


def _mi_int(text: str, key: str) -> int:
    """Extract an integer value from a GDB MI key="N" pair."""
    try:
        return int(_mi_str(text, key))
    except (ValueError, TypeError):
        return 0


def _fresh_var() -> str:
    """Return a unique varobj name for this Python process lifetime."""
    _VCOUNTER[0] += 1
    return f"_v{_VCOUNTER[0]}"


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — Varobj CRUD wrappers
# ═══════════════════════════════════════════════════════════════════════════════

def _var_create(
    child: pexpect.spawn, expr: str
) -> tuple[str, str, str, int]:
    """
    Create a GDB varobj for *expr* in the current selected frame.

    Returns (varobj_name, gdb_type, display_value, numchild).
    Returns ('', '', '', 0) when GDB reports an error (e.g. expr out of scope).
    """
    vname = _fresh_var()
    resp  = _gdb_send(child, f"-var-create {vname} * {expr}")
    if not resp or "^error" in resp:
        return "", "", "", 0
    return (
        vname,
        _mi_str(resp, "type"),
        _mi_str(resp, "value"),
        _mi_int(resp, "numchild"),
    )


def _var_children(
    child: pexpect.spawn, vname: str
) -> list[tuple[str, str, str, str, int]]:
    """
    List all children of a varobj using --all-values so we get values
    for leaf nodes in one round-trip.

    Returns a list of (child_varname, exp_label, gdb_type, value, numchild).
    """
    resp = _gdb_send(child, f"-var-list-children --all-values {vname}")
    out: list[tuple[str, str, str, str, int]] = []

    # Each child: child={name="…",exp="…",numchild="N",value="…",type="…"}
    for m in re.finditer(r"child=\{([^{}]+)\}", resp):
        inner = m.group(1)
        cname = _mi_str(inner, "name")
        if not cname:
            continue
        out.append((
            cname,
            _mi_str(inner, "exp"),
            _mi_str(inner, "type"),
            _mi_str(inner, "value"),
            _mi_int(inner, "numchild"),
        ))
    return out


def _var_delete(child: pexpect.spawn, vname: str) -> None:
    """Delete a varobj and all its children (recursive in GDB)."""
    _gdb_send(child, f"-var-delete {vname}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — Type classification + STL-impl filter
# ═══════════════════════════════════════════════════════════════════════════════

# Child exp labels that are GDB/libstdc++ implementation internals.
# We drop these whether or not pretty-printers are active.
_IMPL_EXP = re.compile(
    r"^(_M_|_S_|_Rb_|_Rep|__\w|<std::|<anonymous|<synthetic)"
)

def _is_impl_child(exp: str) -> bool:
    return not exp or bool(_IMPL_EXP.match(exp))


# Ordered set of (pattern, friendly-label) for STL / smart-ptr types
_STL_LABELS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bvector\b"),         "vector"),
    (re.compile(r"\bbasic_string\b|\bstring\b"), "string"),
    (re.compile(r"\bunordered_map\b"),  "unordered_map"),
    (re.compile(r"\bmap\b"),            "map"),
    (re.compile(r"\bunordered_set\b"),  "unordered_set"),
    (re.compile(r"\bset\b"),            "set"),
    (re.compile(r"\bpair\b"),           "pair"),
    (re.compile(r"\btuple\b"),          "tuple"),
    (re.compile(r"\barray\b"),          "array"),
    (re.compile(r"\blist\b"),           "list"),
    (re.compile(r"\bdeque\b"),          "deque"),
    (re.compile(r"\bstack\b"),          "stack"),
    (re.compile(r"\bqueue\b"),          "queue"),
    (re.compile(r"\bshared_ptr\b"),     "shared_ptr"),
    (re.compile(r"\bunique_ptr\b"),     "unique_ptr"),
    (re.compile(r"\bweak_ptr\b"),       "weak_ptr"),
    (re.compile(r"\boptional\b"),       "optional"),
    (re.compile(r"\bvariant\b"),        "variant"),
]

# C++ primitive base types (without qualifiers)
_PRIMITIVES = {
    "int", "long", "short", "char", "float", "double", "bool",
    "unsigned int", "unsigned long", "unsigned short", "unsigned char",
    "long long", "unsigned long long", "long double",
    "size_t", "ptrdiff_t", "ssize_t",
    "int8_t",  "int16_t",  "int32_t",  "int64_t",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t",
    "void",
}


def _type_label(gdb_type: str) -> str:
    """Return a short friendly label for the type (used in HeapObject.type)."""
    for pat, label in _STL_LABELS:
        if pat.search(gdb_type):
            return label
    stripped = gdb_type.strip()
    if stripped.endswith("*") or stripped.endswith("&"):
        return "pointer"
    return "object"


def _is_primitive(gdb_type: str) -> bool:
    """True for scalar C++ types that should stay inline in the stack row."""
    # Strip qualifiers and trailing * / &
    base = re.sub(r"\b(const|volatile|signed|unsigned)\b", "", gdb_type)
    base = base.strip().rstrip("*& \t")
    return base in _PRIMITIVES


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — Recursive varobj → stack/heap encoder
# ═══════════════════════════════════════════════════════════════════════════════

def _encode(
    child:    pexpect.spawn,
    vname:    str,
    gdb_type: str,
    value:    str,
    numchild: int,
    heap:     dict,
    depth:    int = 0,
) -> str:
    """
    Recursively encode a varobj into one of two forms:

    • Inline  →  "type: value"        (returned as a plain string that
                                        goes into the stack locals dict)
    • Heap    →  "ref: obj_<vname>"   (compound object placed in heap dict)

    Primitives and short strings stay inline.
    Everything compound (vector, map, struct, pointer…) goes to the heap.
    """

    # ── Strings: always inline (value already has quotes from GDB) ───────────
    if _type_label(gdb_type) == "string":
        return f"string: {value}"

    # ── Primitives: inline ────────────────────────────────────────────────────
    if numchild == 0 or _is_primitive(gdb_type):
        disp = value if value else gdb_type
        return f"{gdb_type}: {disp}"

    # ── Compound → heap ───────────────────────────────────────────────────────
    oid = f"obj_{vname}"
    if oid in heap:
        return f"ref: {oid}"     # cycle guard — already being encoded

    label = _type_label(gdb_type)
    # Placeholder breaks cycles for self-referential structures
    heap[oid] = HeapObject(type=label, value=value or "…", fields={})

    if depth >= DEPTH_LIMIT:
        return f"ref: {oid}"

    # Fetch children from GDB
    raw_children = _var_children(child, vname)

    # Keep only logical (non-impl) children
    logical = [c for c in raw_children if not _is_impl_child(c[1])]

    # If pretty-printers are absent we may get only impl nodes;
    # fall back to showing a summary value with no fields.
    if not logical and raw_children:
        summary = value or f"<{label}>"
        heap[oid] = HeapObject(type=label, value=summary, fields={})
        return f"ref: {oid}"

    fields: dict[str, str] = {}
    for cname, cexp, ctype, cval, cnumchild in logical[:MAX_FIELDS]:
        key = cexp  # e.g. "[0]", "first", "second", "x", "y", "head" …

        if cnumchild == 0 or depth + 1 >= DEPTH_LIMIT:
            # Leaf node — display value directly
            fields[key] = cval if cval else (ctype or "?")
        else:
            # Compound child — recurse (depth limit applies)
            sub = _encode(child, cname, ctype, cval, cnumchild, heap, depth + 1)
            fields[key] = sub

    heap[oid] = HeapObject(type=label, value=value or label, fields=fields)
    return f"ref: {oid}"


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — Multi-frame stack capture
# ═══════════════════════════════════════════════════════════════════════════════

def _capture_frames(
    child:    pexpect.spawn,
    src_path: str,               # absolute path to the user source file
) -> tuple[dict[str, dict], dict[str, HeapObject]]:
    """
    Walk the full GDB call stack, encode all *user-code* frames, and
    return (stack_dict, heap_dict) in the shape StepModel expects.

    stack_dict  →  { "func_name": { "var": "encoded_value", … }, … }
    heap_dict   →  { "obj_id": HeapObject(…), … }

    Only frames whose source file matches src_path are included;
    STL / libc frames are silently skipped.
    """
    heap:  dict[str, HeapObject]       = {}
    stack: dict[str, dict[str, str]]   = {}
    created_varobjs: list[str]          = []

    src_basename = Path(src_path).name   # e.g. "main.cpp"

    # Fetch the frame list from GDB
    frames_resp = _gdb_send(child, "-stack-list-frames", timeout=4)

    # Each frame record: frame={level="N",func="…",file="…",fullname="…",line="N"}
    for fm in re.finditer(r"frame=\{([^{}]+)\}", frames_resp):
        inner = fm.group(1)
        level    = _mi_str(inner, "level")
        func     = _mi_str(inner, "func")
        ffile    = _mi_str(inner, "fullname") or _mi_str(inner, "file")

        # Skip non-user frames
        if not ffile:
            continue
        if src_path not in ffile and Path(ffile).name != src_basename:
            continue
        if func in ("", "_start", "__libc_start_main", "__libc_start_call_main"):
            continue

        # Select this frame so -stack-list-variables returns its locals
        _gdb_send(child, f"-stack-select-frame {level}", timeout=3)

        # Get variable names only (0 = no values — we'll use varobj for values)
        names_resp = _gdb_send(child, "-stack-list-variables 0", timeout=3)
        var_names  = re.findall(r'name="([^"]+)"', names_resp)

        locals_dict: dict[str, str] = {}
        for var_name in var_names:
            vname, vtype, vvalue, vnumchild = _var_create(child, var_name)
            if not vname:
                continue
            created_varobjs.append(vname)
            encoded = _encode(child, vname, vtype, vvalue, vnumchild, heap)
            locals_dict[var_name] = encoded

        # Disambiguate if the same function name appears at different levels
        frame_key = func if func not in stack else f"{func}#{level}"
        stack[frame_key] = locals_dict

    # Restore execution frame to the top (frame 0)
    _gdb_send(child, "-stack-select-frame 0", timeout=3)

    # Clean up every varobj we created so GDB doesn't accumulate stale objects
    for vn in created_varobjs:
        _var_delete(child, vn)

    return stack, heap


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — User-code detection helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _extract_stop_info(text: str) -> tuple[str, int]:
    """
    Parse file path and line number from a *stopped GDB MI event.
    Returns (fullname_or_file, line_number).
    """
    ffile = (
        re.search(r'fullname="([^"]*)"', text) or
        re.search(r'file="([^"]*)"', text)
    )
    lm    = re.search(r'line="(\d+)"', text)
    return (
        ffile.group(1) if ffile else "",
        int(lm.group(1)) if lm else 0,
    )


def _in_user_code(cur_file: str, src_path: str) -> bool:
    """True if *cur_file* is the user's source file."""
    if not cur_file:
        return False
    src_basename = Path(src_path).name
    return src_path in cur_file or Path(cur_file).name == src_basename


def _collect_stdout(text: str) -> list[str]:
    """
    Extract program output lines from a GDB MI buffer.
    Program stdout → @"..."  (target output record)
    GDB console   → ~"..."  (console-stream record, rarely contains program out)
    """
    lines: list[str] = []
    for prefix in (r'@"', r'~"'):
        for raw in re.findall(rf'{re.escape(prefix)}(?:[^"\\]|\\.)*"', text):
            decoded = (
                raw[2:-1]
                .replace("\\n", "\n")
                .replace('\\"', '"')
                .replace("\\\\", "\\")
                .replace("\\t", "\t")
            )
            lines.append(decoded)
    return lines


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — Main synchronous trace core
# ═══════════════════════════════════════════════════════════════════════════════

def _trace_sync(code: str) -> ExecuteResponse:
    with tempfile.TemporaryDirectory(prefix="cpp_trace_") as tmpdir:
        tmp      = Path(tmpdir)
        src_file = tmp / "main.cpp"
        exe_file = tmp / "main.out"
        src_file.write_text(code, encoding="utf-8")
        src_str  = str(src_file)

        # ── 1. Compile ────────────────────────────────────────────────────────
        # -g3 gives macro/template info; -fno-omit-frame-pointer keeps
        # clean backtraces; -std=c++17 covers most modern idioms.
        compile_output, rc = pexpect.run(
            (
                f"g++ -std=c++17 -g3 -O0 -fno-omit-frame-pointer "
                f"-o {exe_file} {src_file}"
            ),
            encoding="utf-8",
            withexitstatus=True,
        )
        if rc != 0 or not exe_file.exists():
            return ExecuteResponse(
                success=False,
                message="Compilation failed",
                runtimeError=compile_output.strip(),
                errors=[ErrorLocation(line=0, message=compile_output.strip()[:500])],
                totalSteps=0,
                steps=[],
            )

        # ── 2. Build GDB launch command ───────────────────────────────────────
        if _IS_LINUX:
            gdb_cmd = (
                f"prlimit --as={MEM_LIMIT} "
                f"gdb -q --interpreter=mi {exe_file}"
            )
            preexec = None
        else:
            gdb_cmd = f"gdb -q --interpreter=mi {exe_file}"
            preexec = _set_mem_limit

        # ── 3. Launch GDB ─────────────────────────────────────────────────────
        steps:         list[StepModel] = []
        runtime_error: str | None      = None
        stdout_buf:    list[str]       = []

        try:
            child = pexpect.spawn(
                gdb_cmd,
                encoding="utf-8",
                timeout=12,
                preexec_fn=preexec,
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
            child.expect(r"\(gdb\)", timeout=12)

            # ── GDB session initialisation ────────────────────────────────────
            init_cmds = [
                "set auto-load safe-path /",    # allow libstdc++ pretty-printers
                "set print pretty on",
                "set print object on",
                "set print static-members off",
                "set print elements 64",        # show up to 64 array elements
                "set print max-depth 4",        # nested struct display depth
                "set print repeats 3",          # compress repeated values
            ]
            for cmd in init_cmds:
                _gdb_send(child, cmd, timeout=3)

            # Breakpoint at main + run
            _gdb_send(child, "-break-insert main", timeout=5)
            child.sendline("-exec-run")

            step_count    = 0
            finish_streak = 0   # consecutive -exec-finish calls (non-user frames)

            while step_count < MAX_STEPS:
                idx = child.expect(
                    [
                        r'\*stopped,reason="exited-normally"',  # 0 — clean exit
                        r'\*stopped,reason="exited',            # 1 — non-zero exit
                        r'\*stopped,reason="signal-received"',  # 2 — crash/signal
                        r'\*stopped',                           # 3 — step stop
                        pexpect.TIMEOUT,                        # 4
                        pexpect.EOF,                            # 5
                    ],
                    timeout=7,
                )

                if idx in (0, 5):    # normal exit or EOF
                    break
                if idx == 1:         # non-zero exit code
                    runtime_error = "Process exited with non-zero status"
                    break
                if idx == 2:         # signal (SIGSEGV etc.)
                    combined  = (child.before or "") + (child.after or "")
                    sig_match = re.search(r'signal-meaning="([^"]+)"', combined)
                    runtime_error = (
                        f"Fatal signal: {sig_match.group(1)}"
                        if sig_match else "Fatal signal received"
                    )
                    break
                if idx == 4:         # timeout → likely infinite loop
                    runtime_error = "Execution timeout — possible infinite loop"
                    break

                # idx == 3: stopped at some location
                combined = (child.before or "") + (child.after or "")

                # Collect any program output emitted since last stop
                stdout_buf.extend(_collect_stdout(combined))

                cur_file, line_num = _extract_stop_info(combined)
                in_user = _in_user_code(cur_file, src_str)

                if in_user:
                    # ── Record this execution step ────────────────────────────
                    finish_streak = 0
                    step_count   += 1

                    stack, heap = _capture_frames(child, src_str)

                    steps.append(StepModel(
                        step        = step_count,
                        currentLine = line_num,
                        stdout      = "".join(stdout_buf),
                        stack       = stack,
                        heap        = heap,
                    ))

                    # Step-into: traces function calls (including user recursion)
                    child.sendline("-exec-step")

                else:
                    # ── Inside STL / libc — escape back to user code ──────────
                    finish_streak += 1
                    if finish_streak > MAX_FINISH_ITERS:
                        # Absolute fallback: force past whatever is blocking
                        finish_streak = 0
                        child.sendline("-exec-next")
                    else:
                        # Finish the current non-user function → returns to caller
                        child.sendline("-exec-finish")

        except pexpect.EOF:
            pass    # GDB exited normally
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


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 9 — Async entry point
# ═══════════════════════════════════════════════════════════════════════════════

async def run_cpp(code: str) -> ExecuteResponse:
    """Run the GDB tracer in a thread-pool executor (non-blocking)."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _trace_sync, code)
