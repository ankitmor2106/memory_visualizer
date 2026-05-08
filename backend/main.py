"""
main.py — FastAPI server, Pydantic models, and the central Dispatcher.
"""

import asyncio
import logging
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Import models from our separated models.py file
from models import ExecuteRequest, ExecuteResponse

# Import all four language tracers
from tracers.python_tracer import run_python
from tracers.java_tracer import run_java
from tracers.javascript_tracer import run_javascript
from tracers.cpp_tracer import run_cpp

# ── Constants ────────────────────────────────────────────────────────────────
GLOBAL_TIMEOUT = 30  # seconds; hard wall-clock limit per execution request
MAX_STEPS = 500      # cap on emitted trace steps to protect memory

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="Polyglot Memory Visualizer API",
    version="1.0.0",
    docs_url="/docs",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"], # Explicitly include OPTIONS
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/execute", response_model=ExecuteResponse)
async def execute(req: ExecuteRequest) -> ExecuteResponse:
    """
    Central dispatcher. Selects the correct tracer, enforces the global
    timeout, and normalises the result into ExecuteResponse.
    """
    tracer_map = {
        "python": run_python,
        "java": run_java,
        "javascript": run_javascript,
        "cpp": run_cpp,
    }
    
    # Failsafe in case an unsupported language slips past the model validation
    if req.language not in tracer_map:
         return ExecuteResponse(
            success=False,
            message=f"{req.language} tracer is not configured on the server.",
            totalSteps=0,
            steps=[]
        )

    tracer = tracer_map[req.language]

    try:
        result: ExecuteResponse = await asyncio.wait_for(
            tracer(req.code),
            timeout=GLOBAL_TIMEOUT,
        )
        # Cap steps to prevent memory explosion on the frontend
        if len(result.steps) > MAX_STEPS:
            result.steps = result.steps[:MAX_STEPS]
            result.totalSteps = MAX_STEPS
            result.message += f" (trace capped at {MAX_STEPS} steps)"
        return result

    except asyncio.TimeoutError:
        log.warning("Execution timed out for language=%s", req.language)
        return ExecuteResponse(
            success=False,
            message=f"Execution timed out after {GLOBAL_TIMEOUT} seconds.",
            runtimeError="TimeoutError",
            totalSteps=0,
            steps=[],
        )
    except Exception as exc:
        log.exception("Unhandled dispatcher error for language=%s", req.language)
        return ExecuteResponse(
            success=False,
            message="Internal server error during execution.",
            runtimeError=str(exc),
            totalSteps=0,
            steps=[],
        )


# ── Validation error handler ──────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    log.exception("Unhandled exception on %s", request.url)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})
