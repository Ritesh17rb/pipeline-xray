from __future__ import annotations

from enum import Enum
from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class SpecType(str, Enum):
    OPENAPI = "openapi"
    MAPPING = "mapping"


class SpecInput(BaseModel):
    """Incoming messy spec document."""

    spec_text: str = Field(..., description="Raw OpenAPI or mapping document")
    spec_type: SpecType = Field(SpecType.OPENAPI, description="Type of specification")
    name: Optional[str] = Field(
        default=None,
        description="Optional human-friendly name used in the UI",
    )


class FieldDefinition(BaseModel):
    name: str
    type: str
    required: bool = True
    description: str | None = None


class Endpoint(BaseModel):
    method: str
    path: str
    summary: str
    idempotent: bool = False
    fields: List[FieldDefinition] = Field(default_factory=list)
    risk_tags: List[str] = Field(default_factory=list)


class ParsedSchema(BaseModel):
    title: str
    description: str
    endpoints: List[Endpoint] = Field(default_factory=list)
    risk_flags: List[str] = Field(default_factory=list)


class SpecSummary(BaseModel):
    title: str
    description: str
    endpoint_count: int
    risk_flags: List[str]


class SpecPreviewResponse(BaseModel):
    session_id: str
    summary: SpecSummary


class TestCategory(str, Enum):
    HAPPY_PATH = "Happy Path"
    EDGE_CASE = "Edge Cases"
    MALICIOUS = "Malicious Inputs"
    PROPERTY_BASED = "Property-Based"


class TestCaseDescriptor(BaseModel):
    name: str
    category: TestCategory
    endpoint_path: str
    method: str
    code: str
    description: str
    tags: List[str] = Field(default_factory=list)


class TestPlan(BaseModel):
    spec_title: str
    tests: List[TestCaseDescriptor]


class TestSuite(BaseModel):
    """Concrete test suite built for streaming & execution."""

    tests_by_category: Dict[TestCategory, List[TestCaseDescriptor]]
    estimated_minutes_saved_per_test: float = 5.0

    @property
    def category_counts(self) -> Dict[str, int]:
        return {
            category.value: len(items)
            for category, items in self.tests_by_category.items()
        }

    @property
    def total_tests(self) -> int:
        return sum(len(items) for items in self.tests_by_category.values())

    @property
    def estimated_minutes_saved(self) -> float:
        return self.total_tests * self.estimated_minutes_saved_per_test


class TestGenerationRequest(BaseModel):
    session_id: str
    model: Optional[str] = Field(
        default=None,
        description="Model name for the (mocked) LLM.",
    )
    chaos_level: int = Field(
        default=0,
        description="0=low, 1=medium, 2=high chaos/malice level.",
    )
    compliance_tags: List[str] = Field(
        default_factory=list,
        description="Active regulatory compliance overlays.",
    )


class TestGenerationResponse(BaseModel):
    session_id: str
    categories: Dict[str, int]
    total_tests: int
    estimated_minutes_saved: float
    risk_mitigated_usd: float = 0.0
    pii_findings: List[Dict[str, str]] = Field(default_factory=list)
    flakiness_map: Dict[str, float] = Field(default_factory=dict)
    compliance_tags: List[str] = Field(default_factory=list)


class MockServiceState(BaseModel):
    name: str
    status: str = Field(
        ...,
        description="One of: healthy, slow, down",
    )
    description: str


class ExecutionEvent(BaseModel):
    event: str
    test_name: Optional[str] = None
    category: Optional[str] = None
    node_from: Optional[str] = None
    node_to: Optional[str] = None
    node: Optional[str] = None
    passed: Optional[bool] = None
    explanation: Optional[str] = None


class ExecutionPlan(BaseModel):
    tests_in_order: List[TestCaseDescriptor]
    mocks: List[MockServiceState]


class MockStateResponse(BaseModel):
    session_id: str
    mocks: List[MockServiceState]


class CiStep(BaseModel):
    name: str
    status: str
    duration_seconds: float
    log_summary: str


class CiDeterminismInsight(BaseModel):
    confidence: float = Field(
        ...,
        description="0-1 confidence that the generated tests are deterministic/non-flaky.",
    )
    reasons: List[str]


class CiSummary(BaseModel):
    pipeline_name: str
    steps: List[CiStep]
    determinism: CiDeterminismInsight
    yaml_snippet: str


class DemoSession(BaseModel):
    id: str
    spec_input: SpecInput
    parsed_schema: ParsedSchema
    test_suite: Optional[TestSuite] = None
    execution_plan: Optional[ExecutionPlan] = None
    ci_summary: Optional[CiSummary] = None

