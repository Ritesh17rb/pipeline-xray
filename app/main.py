from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import ci_simulator, execution_engine, llm_mock, models, spec_parser, test_generator


BASE_DIR = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"


app = FastAPI(title="Data Pipe X-Ray")

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


# In-memory demo sessions: not for production use
SESSIONS: Dict[str, models.DemoSession] = {}


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "title": "Data Pipe X-Ray",
        },
    )


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/api/spec/preview", response_model=models.SpecPreviewResponse)
async def spec_preview(payload: models.SpecInput) -> models.SpecPreviewResponse:
    """
    Accept a messy spec document, parse it into an internal schema, and create a demo session.
    """
    session_id = str(uuid.uuid4())
    parsed = spec_parser.parse_spec(payload)

    session = models.DemoSession(
        id=session_id,
        spec_input=payload,
        parsed_schema=parsed,
    )
    SESSIONS[session_id] = session

    return models.SpecPreviewResponse(
        session_id=session_id,
        summary=models.SpecSummary(
            title=parsed.title,
            description=parsed.description,
            endpoint_count=len(parsed.endpoints),
            risk_flags=parsed.risk_flags,
        ),
    )


@app.post("/api/tests/generate", response_model=models.TestGenerationResponse)
async def generate_tests(payload: models.TestGenerationRequest) -> models.TestGenerationResponse:
    """
    Generate categorized test cases for a given session and attach execution plan + CI metadata.
    """
    session = SESSIONS.get(payload.session_id)
    if session is None:
        return JSONResponse(
            status_code=404,
            content={"detail": "Session not found"},
        )

    test_plan = llm_mock.generate_tests_from_spec(
        spec=session.parsed_schema,
        model_name=payload.model or "gpt-5-nano",
        chaos_level=payload.chaos_level,
        compliance_tags=payload.compliance_tags,
    )
    suite = test_generator.build_test_suite(test_plan)
    session.test_suite = suite

    execution_plan = execution_engine.build_execution_plan(suite)
    session.execution_plan = execution_plan

    ci_summary = ci_simulator.build_ci_summary(suite)
    session.ci_summary = ci_summary

    SESSIONS[payload.session_id] = session

    risk_per_test = 12_000
    risk_total = suite.total_tests * risk_per_test

    pii_findings = [
        {"field": "customer_name", "type": "Name", "risk": "medium",
         "detail": "Customer name passed through to analytics feed unmasked."},
        {"field": "ssn", "type": "SSN", "risk": "critical",
         "detail": "Social Security Number detected in payload. Must be masked before logging."},
        {"field": "card", "type": "Credit Card", "risk": "critical",
         "detail": "Card number (Visa) in payload. PCI-DSS requires tokenization."},
        {"field": "email", "type": "Email", "risk": "high",
         "detail": "Email address leaking to non-prod downstream. GDPR violation risk."},
    ]

    flakiness_map = {
        "API Gateway": 0.02,
        "Validator": 0.05,
        "Transformer": 0.28,
        "Database": 0.03,
        "Legacy Emulator": 0.35,
        "Risk Score API": 0.12,
    }

    return models.TestGenerationResponse(
        session_id=payload.session_id,
        categories=suite.category_counts,
        total_tests=suite.total_tests,
        estimated_minutes_saved=suite.estimated_minutes_saved,
        risk_mitigated_usd=risk_total,
        pii_findings=pii_findings,
        flakiness_map=flakiness_map,
        compliance_tags=payload.compliance_tags,
    )


@app.get("/api/ci/summary", response_model=models.CiSummary)
async def get_ci_summary(session_id: str) -> models.CiSummary:
    session = SESSIONS.get(session_id)
    if session is None or session.ci_summary is None:
        return JSONResponse(
            status_code=404,
            content={"detail": "Session not found"},
        )
    return session.ci_summary


@app.get("/api/mocks", response_model=models.MockStateResponse)
async def get_mocks(session_id: str) -> models.MockStateResponse:
    session = SESSIONS.get(session_id)
    if session is None or session.execution_plan is None:
        return JSONResponse(
            status_code=404,
            content={"detail": "Session not found"},
        )
    return models.MockStateResponse(
        session_id=session.id,
        mocks=session.execution_plan.mocks,
    )


@app.websocket("/ws/tests/code-stream/{session_id}")
async def websocket_code_stream(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    try:
        session = SESSIONS.get(session_id)
        if session is None or session.test_suite is None:
            await websocket.send_json({"event": "error", "message": "Session not ready"})
            await websocket.close()
            return

        async for msg in test_generator.stream_code_chunks(session.test_suite):
            await websocket.send_json(msg)

        await websocket.send_json({"event": "done"})
    except WebSocketDisconnect:
        return


@app.websocket("/ws/tests/xray-stream/{session_id}")
async def websocket_xray_stream(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    try:
        session = SESSIONS.get(session_id)
        if session is None or session.execution_plan is None:
            await websocket.send_json({"event": "error", "message": "Session not ready"})
            await websocket.close()
            return

        async for evt in execution_engine.stream_execution_events(session.execution_plan):
            await websocket.send_json(evt)

        await websocket.send_json({"event": "done"})
    except WebSocketDisconnect:
        return

