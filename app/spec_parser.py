from __future__ import annotations

from typing import List

from . import models


SAMPLE_OPENAPI_SNIPPET = """
openapi: 3.0.1
info:
  title: Payments & Events API
  description: |
    Backend for processing payments and emitting business events to downstream systems,
    including legacy mainframe mirrors and analytics feeds.
paths:
  /payments:
    post:
      summary: Create a new payment
  /payments/{payment_id}:
    get:
      summary: Get payment details
  /events:
    post:
      summary: Ingest business event
"""


def _default_fields_for_payments() -> List[models.FieldDefinition]:
    return [
        models.FieldDefinition(
            name="payment_id",
            type="string",
            required=False,
            description="Assigned by the system",
        ),
        models.FieldDefinition(
            name="amount",
            type="number",
            required=True,
            description="Payment amount in minor units",
        ),
        models.FieldDefinition(
            name="currency",
            type="string",
            required=True,
            description="ISO currency code",
        ),
        models.FieldDefinition(
            name="customer_name",
            type="string",
            required=True,
            description="Name as provided by upstream (can contain emojis, RTL text, etc.)",
        ),
    ]


def _default_fields_for_events() -> List[models.FieldDefinition]:
    return [
        models.FieldDefinition(
            name="event_id",
            type="string",
            required=False,
            description="Idempotency key; repeated sends should not duplicate state",
        ),
        models.FieldDefinition(
            name="event_type",
            type="string",
            required=True,
            description="Business event type",
        ),
        models.FieldDefinition(
            name="event_date",
            type="string",
            required=True,
            description="Business date in YYYY-MM-DD, though some producers send a Unix timestamp",
        ),
        models.FieldDefinition(
            name="payload",
            type="object",
            required=True,
            description="Opaque payload forwarded to legacy systems",
        ),
        models.FieldDefinition(
            name="extra_marketing_flag",
            type="boolean",
            required=False,
            description=(
                "Undocumented field occasionally injected by upstream CRM; "
                "used to demonstrate schema-drift tolerance."
            ),
        ),
    ]


def parse_spec(spec_input: models.SpecInput) -> models.ParsedSchema:
    """
    Turn a messy OpenAPI / mapping document into a structured ParsedSchema.

    For this demo we do not implement a full OpenAPI parser; instead, we:
    - Accept the incoming text to show in the UI.
    - Populate a deterministic internal schema tailored to the narrative.
    """
    text = (spec_input.spec_text or "").strip()
    if not text:
        text = SAMPLE_OPENAPI_SNIPPET

    # In a real implementation we would inspect `text`. Here we return a rich,
    # pre-baked schema that lines up with the demo story.
    payments_post = models.Endpoint(
        method="POST",
        path="/payments",
        summary="Create a new payment",
        idempotent=False,
        fields=_default_fields_for_payments(),
        risk_tags=[
            "amount_range",
            "currency_support",
            "sql_injection_in_name",
        ],
    )

    payments_get = models.Endpoint(
        method="GET",
        path="/payments/{payment_id}",
        summary="Retrieve payment by id",
        idempotent=True,
        fields=[
            models.FieldDefinition(
                name="payment_id",
                type="string",
                required=True,
                description="Primary key of the payment",
            )
        ],
        risk_tags=["authorization", "idempotency"],
    )

    events_post = models.Endpoint(
        method="POST",
        path="/events",
        summary="Ingest business event",
        idempotent=True,
        fields=_default_fields_for_events(),
        risk_tags=[
            "schema_drift",
            "date_type_mutation",
            "legacy_emulator",
        ],
    )

    risk_flags = [
        "Schema drift from undocumented fields like extra_marketing_flag",
        "Date field event_date may arrive as either YYYY-MM-DD or Unix timestamp",
        "Idempotency expectations on /events via event_id",
        "Downstream legacy emulator integration may be unavailable or slow",
    ]

    return models.ParsedSchema(
        title=spec_input.name or "Payments & Events API",
        description=(
            "API that accepts high-volume payments and business events, "
            "fan-out to analytics and legacy mainframe mirrors, and must "
            "tolerate schema drift and upstream quirks."
        ),
        endpoints=[payments_post, payments_get, events_post],
        risk_flags=risk_flags,
    )

