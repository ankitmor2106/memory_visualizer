"""
tracers/java_tracer.py

Workflow
────────
1. Write user code to a temp directory.
2. Compile with `javac`.  Parse compiler output into ErrorLocation list.
3. Launch the JVM with JDWP (debug wire protocol) in server=y,suspend=y mode
   so it pauses before main() executes.
4. Separately launch JvmTraceAgent (a pure-Java program that attaches via
   JDI socket and drives stepping + inspection) as a subprocess.
5. Read the newline-delimited JSON lines that JvmTraceAgent emits on stdout.
6. Assemble into ExecuteResponse.

JvmTraceAgent.java is embedded as a Python string constant (JAVA_AGENT_SOURCE)
so the whole backend ships as a single Python package.  The Dockerfile compiles
it once during image build; at runtime we just load the pre-compiled .class.

JVM flags
─────────
  -Xmx128m         — hard heap cap
  -XX:TieredStopAtLevel=1 — disable JIT tiers 2-4 for much faster cold start
  -agentlib:jdwp   — JDWP debug port; suspend=y so we can attach before main()
"""

import asyncio
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from models import ExecuteResponse, StepModel, HeapObject, ErrorLocation

# Path where JvmTraceAgent.class was compiled at image build time
AGENT_CLASS_DIR = Path("/app")
TOOLS_JAR = Path(os.environ.get(
    "TOOLS_JAR",
    "/usr/lib/jvm/java-17-openjdk-amd64/lib/tools.jar"
))

# ── Embedded JvmTraceAgent Java source ───────────────────────────────────────
JAVA_AGENT_SOURCE = r"""
import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.io.*;
import java.util.*;

/**
 * JvmTraceAgent — attaches to a waiting JVM via JDI socket and steps through
 * the user's code line by line, emitting one JSON object per step on stdout.
 *
 * Usage: java -cp <tools.jar>:<agent_dir> JvmTraceAgent <port>
 *
 * JSON line format (one per step):
 *   {"step":N,"line":L,"stdout":"...","stack":{...},"heap":{...}}
 * End sentinel (runtime error or normal exit):
 *   {"done":true,"runtimeError":null}  |  {"done":true,"runtimeError":"..."}
 */
public class JvmTraceAgent {

    private static final int MAX_STEPS = 500;
    private static final int DEPTH_LIMIT = 3; // heap traversal depth

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);

        // Attach via socket connector (JDI)
        VirtualMachineManager vmm = Bootstrap.virtualMachineManager();
        AttachingConnector connector = vmm.attachingConnectors().stream()
            .filter(c -> c.name().contains("SocketAttach"))
            .findFirst()
            .orElseThrow(() -> new RuntimeException("No socket connector found"));

        Map<String, Connector.Argument> params = connector.defaultArguments();
        params.get("hostname").setValue("127.0.0.1");
        params.get("port").setValue(String.valueOf(port));

        VirtualMachine vm = connector.attach(params);
        EventRequestManager erm = vm.eventRequestManager();

        // Enable line-level stepping on all threads
        StepRequest stepReq = erm.createStepRequest(
            vm.allThreads().get(0),
            StepRequest.STEP_LINE,
            StepRequest.STEP_INTO
        );
        stepReq.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
        stepReq.enable();

        // Capture stdout by redirecting System.out inside the target JVM
        // (We read Process stdout on the Python side; the target JVM inherits
        //  our pipe, so its System.out flows back to us automatically.)

        StringBuilder stdoutAccum = new StringBuilder();
        int stepCount = 0;
        String runtimeError = null;

        vm.resume();

        EventQueue eq = vm.eventQueue();
        outer:
        while (true) {
            EventSet es;
            try {
                es = eq.remove(5000); // 5s poll so we don't hang if VM exits
            } catch (InterruptedException e) {
                break;
            }
            if (es == null) break;

            for (Event ev : es) {
                if (ev instanceof VMDeathEvent || ev instanceof VMDisconnectEvent) {
                    break outer;
                }
                if (ev instanceof StepEvent se) {
                    Location loc = se.location();
                    // Skip synthetic classes and JDK internals
                    String cls = loc.declaringType().name();
                    if (cls.startsWith("java.") || cls.startsWith("sun.")
                            || cls.startsWith("jdk.") || cls.startsWith("com.sun.")) {
                        es.resume();
                        continue;
                    }

                    stepCount++;
                    if (stepCount > MAX_STEPS) {
                        runtimeError = "ExecutionLimitExceeded: possible infinite loop";
                        break outer;
                    }

                    Map<String, Object> snap = buildSnapshot(se.thread(), loc, stepCount, stdoutAccum.toString());
                    System.out.println(toJson(snap));
                    System.out.flush();

                    if (stepCount < MAX_STEPS) {
                        es.resume();
                    }
                } else if (ev instanceof ExceptionEvent xe) {
                    runtimeError = xe.exception().type().name()
                        + ": " + describeException(xe.exception());
                    break outer;
                }
            }
        }

        // Emit done sentinel
        Map<String, Object> done = new LinkedHashMap<>();
        done.put("done", true);
        done.put("runtimeError", runtimeError);
        System.out.println(toJson(done));
        System.out.flush();

        try { vm.dispose(); } catch (Exception ignored) {}
    }

    // ── Snapshot builder ─────────────────────────────────────────────────────

    private static Map<String, Object> buildSnapshot(ThreadReference thread,
            Location loc, int step, String stdout) {
        Map<String, Object> snap = new LinkedHashMap<>();
        snap.put("step", step);
        snap.put("line", loc.lineNumber());
        snap.put("stdout", stdout);

        Map<String, Object> stackMap = new LinkedHashMap<>();
        Map<String, Object> heap = new LinkedHashMap<>();

        try {
            List<StackFrame> frames = thread.frames();
            for (StackFrame frame : frames) {
                String method = frame.location().declaringType().name()
                    + "." + frame.location().method().name();
                if (method.contains("JvmTraceAgent")) continue;

                Map<String, Object> locals = new LinkedHashMap<>();
                try {
                    for (LocalVariable lv : frame.visibleVariables()) {
                        Value val = frame.getValue(lv);
                        locals.put(lv.name(), encodeValue(val, heap, 0));
                    }
                } catch (AbsentInformationException ignored) {}
                stackMap.put(method, locals);
            }
        } catch (IncompatibleThreadStateException ignored) {}

        snap.put("stack", stackMap);
        snap.put("heap", heap);
        return snap;
    }

    // ── Value encoder ─────────────────────────────────────────────────────────

    private static Object encodeValue(Value v, Map<String, Object> heap, int depth) {
        if (v == null) return "null";
        if (v instanceof PrimitiveValue || v instanceof StringReference) {
            return v.toString();
        }
        if (!(v instanceof ObjectReference obj)) return v.toString();

        String oid = "obj_" + obj.uniqueID();
        if (heap.containsKey(oid)) return "ref: " + oid;
        if (depth >= DEPTH_LIMIT) {
            // Placeholder to avoid infinite recursion on deep graphs
            heap.put(oid, Map.of("type", obj.type().name(), "value", "…", "fields", Map.of()));
            return "ref: " + oid;
        }

        Map<String, Object> fields = new LinkedHashMap<>();
        String typeName = obj.type().name();
        String value = "";

        if (obj instanceof ArrayReference arr) {
            typeName = arr.type().name();
            value = "[" + arr.length() + " items]";
            for (int i = 0; i < arr.length(); i++) {
                fields.put(String.valueOf(i), encodeValue(arr.getValue(i), heap, depth + 1));
            }
        } else {
            // Regular object — expose all fields
            heap.put(oid, Map.of("type", typeName, "value", "…", "fields", Map.of()));
            for (Field f : obj.referenceType().allFields()) {
                try {
                    fields.put(f.name(), encodeValue(obj.getValue(f), heap, depth + 1));
                } catch (Exception ignored) {}
            }
            value = typeName + "@" + Long.toHexString(obj.uniqueID());
        }

        heap.put(oid, Map.of("type", typeName, "value", value, "fields", fields));
        return "ref: " + oid;
    }

    // ── Exception description ─────────────────────────────────────────────────

    private static String describeException(ObjectReference exc) {
        try {
            Field msgField = exc.referenceType().fieldByName("detailMessage");
            if (msgField != null) {
                Value v = exc.getValue(msgField);
                return v != null ? v.toString() : "(no message)";
            }
        } catch (Exception ignored) {}
        return "(no message)";
    }

    // ── Minimal JSON serialiser (no external dependency) ─────────────────────

    @SuppressWarnings("unchecked")
    private static String toJson(Object obj) {
        if (obj == null) return "null";
        if (obj instanceof Boolean b) return b.toString();
        if (obj instanceof Number n) return n.toString();
        if (obj instanceof String s) return "\"" + jsonEscape(s) + "\"";
        if (obj instanceof List<?> list) {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(',');
                sb.append(toJson(list.get(i)));
            }
            return sb.append(']').toString();
        }
        if (obj instanceof Map<?,?> map) {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append("\"").append(jsonEscape(e.getKey().toString())).append("\":");
                sb.append(toJson(e.getValue()));
            }
            return sb.append('}').toString();
        }
        return "\"" + jsonEscape(obj.toString()) + "\"";
    }

    private static String jsonEscape(String s) {
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }
}
"""

# ── Compile-error parser ──────────────────────────────────────────────────────

_JAVAC_ERROR_RE = re.compile(r"^.+?:(\d+):\s+error:\s+(.+)$", re.MULTILINE)


def _parse_javac_errors(stderr: str) -> list[ErrorLocation]:
    return [
        ErrorLocation(line=int(m.group(1)), message=m.group(2).strip())
        for m in _JAVAC_ERROR_RE.finditer(stderr)
    ] or [ErrorLocation(line=0, message=stderr.strip())]


# ── Main entry point ──────────────────────────────────────────────────────────

async def run_java(code: str) -> ExecuteResponse:
    """Compile + trace Java code via JDI."""
    with tempfile.TemporaryDirectory(prefix="jvm_trace_") as tmpdir:
        tmp = Path(tmpdir)

        # Detect public class name (required to name the .java file)
        m = re.search(r"\bpublic\s+class\s+(\w+)", code)
        class_name = m.group(1) if m else "Main"
        src_file = tmp / f"{class_name}.java"
        src_file.write_text(code)

        # ── Step 1: Compile ────────────────────────────────────────────────────
        compile_proc = await asyncio.create_subprocess_exec(
            "javac", str(src_file), "-d", str(tmp),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr_bytes = await compile_proc.communicate()
        if compile_proc.returncode != 0:
            return ExecuteResponse(
                success=False,
                message="Compilation failed",
                errors=_parse_javac_errors(stderr_bytes.decode()),
                totalSteps=0,
                steps=[],
            )

        # ── Step 2: Launch JVM with JDWP ──────────────────────────────────────
        # Port 0 asks OS to pick a free port; we read it from the JVM output.
        jvm_proc = await asyncio.create_subprocess_exec(
            "java",
            f"-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0",
            "-Xmx128m",
            "-XX:TieredStopAtLevel=1",
            "-cp", str(tmp),
            class_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # JDWP prints "Listening for transport dt_socket at address: <port>"
        port: int | None = None
        stderr_lines: list[str] = []
        assert jvm_proc.stderr is not None
        async for raw_line in jvm_proc.stderr:
            line = raw_line.decode()
            stderr_lines.append(line)
            pm = re.search(r"address: 127\.0\.0\.1:(\d+)", line)
            if pm:
                port = int(pm.group(1))
                break

        if port is None:
            jvm_proc.kill()
            return ExecuteResponse(
                success=False,
                message="Failed to start JVM debug session",
                runtimeError="".join(stderr_lines),
                totalSteps=0,
                steps=[],
            )

        # ── Step 3: Launch JvmTraceAgent ──────────────────────────────────────
        agent_cp = f"{AGENT_CLASS_DIR}:{TOOLS_JAR}"
        agent_proc = await asyncio.create_subprocess_exec(
            "java", "-cp", agent_cp, "JvmTraceAgent", str(port),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )

        # ── Step 4: Read newline-delimited JSON from agent ────────────────────
        steps: list[StepModel] = []
        runtime_error: str | None = None

        assert agent_proc.stdout is not None
        async for raw_line in agent_proc.stdout:
            try:
                obj = json.loads(raw_line.decode().strip())
            except json.JSONDecodeError:
                continue

            if obj.get("done"):
                runtime_error = obj.get("runtimeError")
                break

            heap = {
                oid: HeapObject(
                    type=ho["type"],
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

        # Clean up
        try:
            agent_proc.kill()
        except ProcessLookupError:
            pass
        try:
            jvm_proc.kill()
        except ProcessLookupError:
            pass
        await agent_proc.wait()
        await jvm_proc.wait()

        return ExecuteResponse(
            success=runtime_error is None,
            message="OK" if runtime_error is None else "Runtime error",
            runtimeError=runtime_error,
            totalSteps=len(steps),
            steps=steps,
        )