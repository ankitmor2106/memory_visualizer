"""
main.py — FastAPI orchestrator for the Polyglot Memory Visualizer.

Key safety rails
────────────────
1. 30-second global wall-clock timeout per request (asyncio.wait_for).
2. Hard cap of MAX_STEPS (500) execution steps.
3. Payload-size guard: if the serialised JSON response exceeds 5 MB,
   steps are aggressively truncated to PAYLOAD_TRUNCATED_STEPS (100)
   and a warning is appended to the message — preventing OOM crashes
   in the browser when a near-infinite loop produces massive traces.
"""

import asyncio
import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from models import ExecuteRequest, ExecuteResponse
from tracers.python_tracer import run_python
from tracers.java_tracer import run_java
from tracers.javascript_tracer import run_javascript
from tracers.cpp_tracer import run_cpp

# ── Constants ─────────────────────────────────────────────────────────────────
GLOBAL_TIMEOUT          = 90          # seconds
MAX_STEPS               = 500         # hard step cap
MAX_PAYLOAD_BYTES       = 5_242_880   # 5 MiB
PAYLOAD_TRUNCATED_STEPS = 100         # fallback step count when payload is huge

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")
log = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Polyglot Memory Visualizer API",
    version="2.0.0",
    docs_url="/docs",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}

@app.get("/")
async def root() -> dict[str, str]:
    return {"status": "ok", "service": "Memory Visualizer API"}


# ── Main execute endpoint ─────────────────────────────────────────────────────
@app.post("/execute", response_model=ExecuteResponse)
async def execute(req: ExecuteRequest) -> ExecuteResponse:
    """
    Route the request to the appropriate language tracer, enforce timeouts,
    and apply the step / payload guards before returning.
    """
    tracer_map = {
        "python":     run_python,
        "java":       run_java,
        "javascript": run_javascript,
        "cpp":        run_cpp,
    }

    if req.language not in tracer_map:
        return ExecuteResponse(
            success=False,
            message=f"No tracer configured for language '{req.language}'.",
            totalSteps=0,
            steps=[],
        )

    tracer = tracer_map[req.language]

    # ── Execute with global timeout ───────────────────────────────────────────
    try:
        result: ExecuteResponse = await asyncio.wait_for(
            tracer(req.code),
            timeout=GLOBAL_TIMEOUT,
        )
    except asyncio.TimeoutError:
        log.warning("Execution timed out [language=%s]", req.language)
        return ExecuteResponse(
            success=False,
            message=f"Execution timed out after {GLOBAL_TIMEOUT} seconds.",
            runtimeError="TimeoutError",
            totalSteps=0,
            steps=[],
        )
    except Exception as exc:
        log.exception("Unhandled tracer error [language=%s]", req.language)
        return ExecuteResponse(
            success=False,
            message="Internal server error during execution.",
            runtimeError=str(exc),
            totalSteps=0,
            steps=[],
        )

    # ── Guard 1: step count cap ───────────────────────────────────────────────
    if len(result.steps) > MAX_STEPS:
        result.steps = result.steps[:MAX_STEPS]
        result.totalSteps = MAX_STEPS
        result.message += f" (trace capped at {MAX_STEPS} steps)"

    # ── Guard 2: payload size cap ─────────────────────────────────────────────
    # Serialise to measure size. On very large traces this is cheaper than
    # discovering the problem after the response is sent.
    try:
        payload_bytes = len(result.model_dump_json().encode("utf-8"))
    except Exception:
        payload_bytes = 0

    if payload_bytes > MAX_PAYLOAD_BYTES:
        log.warning(
            "Payload %d bytes exceeds %d MB limit — truncating to %d steps [language=%s]",
            payload_bytes, MAX_PAYLOAD_BYTES // 1_048_576,
            PAYLOAD_TRUNCATED_STEPS, req.language,
        )
        result.steps     = result.steps[:PAYLOAD_TRUNCATED_STEPS]
        result.totalSteps = PAYLOAD_TRUNCATED_STEPS
        result.message   += (
            f" ⚠️ Response exceeded 5 MB — trace truncated to "
            f"{PAYLOAD_TRUNCATED_STEPS} steps to prevent browser memory crash."
        )

    return result


# ── Global exception handler ──────────────────────────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    log.exception("Unhandled exception on %s", request.url)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )
