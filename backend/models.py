"""
models.py — Pydantic data contracts for the Polyglot Memory Visualizer API.
"""
from typing import Any, Optional
from pydantic import BaseModel, field_validator

SUPPORTED_LANGUAGES = {"python", "java", "javascript", "cpp"}
MAX_CODE_LENGTH = 50_000


class ExecuteRequest(BaseModel):
    code: str
    language: str

    @field_validator("language")
    @classmethod
    def lang_must_be_supported(cls, v: str) -> str:
        v = v.lower().strip()
        if v not in SUPPORTED_LANGUAGES:
            raise ValueError(f"language must be one of {sorted(SUPPORTED_LANGUAGES)}")
        return v

    @field_validator("code")
    @classmethod
    def code_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("code must not be empty")
        if len(v) > MAX_CODE_LENGTH:
            raise ValueError(f"code exceeds {MAX_CODE_LENGTH} characters")
        return v


class ErrorLocation(BaseModel):
    line: int
    message: str


class HeapObject(BaseModel):
    type: str
    value: str = ""
    fields: dict[str, Any] = {}


class StepModel(BaseModel):
    step: int
    currentLine: int
    stdout: str
    stack: dict[str, dict[str, Any]]
    heap: dict[str, HeapObject]


class ExecuteResponse(BaseModel):
    success: bool
    message: str
    errors: list[ErrorLocation] = []
    runtimeError: Optional[str] = None
    totalSteps: int
    steps: list[StepModel]
