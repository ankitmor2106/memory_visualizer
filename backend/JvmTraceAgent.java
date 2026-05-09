
import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.util.*;

/**
 * JvmTraceAgent — attaches to a waiting JVM via JDI and steps through
 * user code line-by-line, emitting one JSON object per step on stdout.
 *
 * Usage:  java -cp <agent_dir> JvmTraceAgent <port>
 *
 * Step line:
 *   {"step":N,"line":L,"stdout":"...","stack":{...},"heap":{...}}
 * Done sentinel:
 *   {"done":true,"runtimeError":null}  or  {"done":true,"runtimeError":"..."}
 */
public class JvmTraceAgent {

    private static final int MAX_STEPS   = 500;
    private static final int DEPTH_LIMIT = 3;

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);

        VirtualMachineManager vmm = Bootstrap.virtualMachineManager();
        AttachingConnector connector = vmm.attachingConnectors().stream()
            .filter(c -> c.name().contains("SocketAttach"))
            .findFirst()
            .orElseThrow(() -> new RuntimeException("No SocketAttach connector"));

        Map<String, Connector.Argument> params = connector.defaultArguments();
        params.get("hostname").setValue("127.0.0.1");
        params.get("port").setValue(String.valueOf(port));

        VirtualMachine vm = connector.attach(params);
        EventRequestManager erm = vm.eventRequestManager();

        // Step at line granularity on the main thread
        ThreadReference mainThread = vm.allThreads().stream()
            .filter(t -> t.name().equals("main"))
            .findFirst()
            .orElse(vm.allThreads().get(0));

        StepRequest stepReq = erm.createStepRequest(
            mainThread, StepRequest.STEP_LINE, StepRequest.STEP_INTO
        );
        stepReq.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
        stepReq.enable();

        // Enable exception notification
        ExceptionRequest excReq = erm.createExceptionRequest(null, true, true);
        excReq.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
        excReq.enable();

        int    stepCount   = 0;
        String runtimeError = null;

        vm.resume();

        EventQueue eq = vm.eventQueue();
        outer:
        while (true) {
            EventSet es;
            try {
                es = eq.remove(5_000);
            } catch (InterruptedException e) {
                break;
            }
            if (es == null) break;

            for (Event ev : es) {
                if (ev instanceof VMDeathEvent || ev instanceof VMDisconnectEvent) {
                    break outer;
                }

                if (ev instanceof ExceptionEvent xe) {
                    runtimeError = xe.exception().type().name()
                        + ": " + describeException(xe.exception());
                    break outer;
                }

                if (ev instanceof StepEvent se) {
                    Location loc = se.location();
                    String cls = loc.declaringType().name();
                    // Skip JDK internals
                    if (cls.startsWith("java.") || cls.startsWith("sun.")
                        || cls.startsWith("jdk.")  || cls.startsWith("com.sun.")) {
                        es.resume();
                        continue;
                    }

                    if (++stepCount > MAX_STEPS) {
                        runtimeError = "ExecutionLimitExceeded: possible infinite loop";
                        break outer;
                    }

                    Map<String, Object> snap = buildSnapshot(se.thread(), loc, stepCount);
                    System.out.println(toJson(snap));
                    System.out.flush();
                    es.resume();
                }
            }
        }

        Map<String, Object> done = new LinkedHashMap<>();
        done.put("done", true);
        done.put("runtimeError", runtimeError);
        System.out.println(toJson(done));
        System.out.flush();

        try { vm.dispose(); } catch (Exception ignored) {}
    }

    // ── Snapshot ──────────────────────────────────────────────────────────────

    private static Map<String, Object> buildSnapshot(ThreadReference thread,
            Location loc, int step) {
        Map<String, Object> snap = new LinkedHashMap<>();
        snap.put("step", step);
        snap.put("line", loc.lineNumber());
        snap.put("stdout", ""); // stdout captured separately on the Python side

        Map<String, Object> stackMap = new LinkedHashMap<>();
        Map<String, Object> heap     = new LinkedHashMap<>();

        try {
            for (StackFrame frame : thread.frames()) {
                String method = frame.location().declaringType().name()
                    + "." + frame.location().method().name();
                if (method.contains("JvmTraceAgent")) continue;

                Map<String, Object> locals = new LinkedHashMap<>();
                try {
                    for (LocalVariable lv : frame.visibleVariables()) {
                        locals.put(lv.name(), encodeValue(frame.getValue(lv), heap, 0));
                    }
                } catch (AbsentInformationException ignored) {}
                stackMap.put(method, locals);
            }
        } catch (IncompatibleThreadStateException ignored) {}

        snap.put("stack", stackMap);
        snap.put("heap",  heap);
        return snap;
    }

    // ── Value encoder ─────────────────────────────────────────────────────────

    private static Object encodeValue(Value v, Map<String, Object> heap, int depth) {
        if (v == null) return "null";
        if (v instanceof PrimitiveValue || v instanceof StringReference)
            return v.toString();
        if (!(v instanceof ObjectReference obj)) return v.toString();

        String oid = "obj_" + obj.uniqueID();
        if (heap.containsKey(oid)) return "ref: " + oid;
        if (depth >= DEPTH_LIMIT) {
            heap.put(oid, Map.of("type", obj.type().name(), "value", "…", "fields", Map.of()));
            return "ref: " + oid;
        }

        Map<String, Object> fields = new LinkedHashMap<>();
        String typeName = obj.type().name();
        String value;

        if (obj instanceof ArrayReference arr) {
            value = "[" + arr.length() + " items]";
            for (int i = 0; i < arr.length(); i++)
                fields.put(String.valueOf(i), encodeValue(arr.getValue(i), heap, depth + 1));
        } else {
            // Placeholder first to avoid cycles
            heap.put(oid, Map.of("type", typeName, "value", "…", "fields", Map.of()));
            for (Field f : obj.referenceType().allFields()) {
                try { fields.put(f.name(), encodeValue(obj.getValue(f), heap, depth + 1)); }
                catch (Exception ignored) {}
            }
            value = typeName + "@" + Long.toHexString(obj.uniqueID());
        }

        heap.put(oid, Map.of("type", typeName, "value", value, "fields", fields));
        return "ref: " + oid;
    }

    // ── Exception description ─────────────────────────────────────────────────

    private static String describeException(ObjectReference exc) {
        try {
            Field f = exc.referenceType().fieldByName("detailMessage");
            if (f != null) { Value v = exc.getValue(f); return v != null ? v.toString() : "(no message)"; }
        } catch (Exception ignored) {}
        return "(no message)";
    }

    // ── Minimal JSON serialiser ───────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private static String toJson(Object obj) {
        if (obj == null)            return "null";
        if (obj instanceof Boolean) return obj.toString();
        if (obj instanceof Number)  return obj.toString();
        if (obj instanceof String s) return "\"" + escape(s) + "\"";
        if (obj instanceof List<?> list) {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) { if (i > 0) sb.append(','); sb.append(toJson(list.get(i))); }
            return sb.append(']').toString();
        }
        if (obj instanceof Map<?,?> map) {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (var e : map.entrySet()) {
                if (!first) sb.append(','); first = false;
                sb.append('"').append(escape(e.getKey().toString())).append("\":").append(toJson(e.getValue()));
            }
            return sb.append('}').toString();
        }
        return "\"" + escape(obj.toString()) + "\"";
    }

    private static String escape(String s) {
        return s.replace("\\","\\\\").replace("\"","\\\"")
                .replace("\n","\\n").replace("\r","\\r").replace("\t","\\t");
    }
}
