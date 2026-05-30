# Cedar Kids Therapy — Referral Inbox Triage Agent

## How to Run

```bash
npm install
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

Defaults work with no flags:
```bash
npm run triage
npm run validate
```

Set your Anthropic API key in the environment before running:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Stack and Runtime

- **Language**: TypeScript, Node LTS
- **LLM**: Anthropic Claude claude-sonnet-4-20250514 via `@anthropic-ai/sdk`
- **Key**: Read from `ANTHROPIC_API_KEY` environment variable — never committed
- **Runtime**: ~30–60 seconds for 8 items (parallel LLM calls, ~1 call per item)
- **Built with**: Claude (claude.ai) as a coding assistant for scaffolding and review

## Architecture

**LLM extraction + deterministic tool routing**

Each inbox item goes through two stages:

### Stage 1 — LLM Extraction (`extractWithLLM`)
One `claude-sonnet-4-20250514` call per item. The system prompt instructs the model to return
structured JSON containing:
- `classification`, `urgency`, `requires_human_review`
- `extracted_intake` (child name, DOB, payer, etc.)
- `missing_info`, `decision_rationale`, `recommended_next_action`, `draft_reply`

The LLM is responsible for reading the item and surfacing what's in it. Critically, the system
prompt encodes the safety and clinical advice rules so the LLM applies them during extraction.

### Stage 2 — Tool Orchestration (`orchestrateTools`)
TypeScript drives the tool calls deterministically based on classification. This is a deliberate
design choice: safety-critical routing (P0 safeguarding, out-of-network blocking) lives in
explicit code, not in LLM judgment. The decision tree is:

```
P0 / safeguarding  → escalate + lookup_policy(safeguarding) + create_task(clinical_lead)
P1 / scheduling    → search_patient + find_slots + hold_slot + create_task(front_desk)
clinical_question  → lookup_policy(clinical_advice) + draft_message
missing_paperwork  → create_task(intake) [no outbound message]
new_referral
  ├─ out-of-network/expired → verify_insurance + lookup_policy(insurance) + create_task(billing)
  └─ in-network/unknown    → search_patient + verify_insurance + find_slots + hold_slot + create_task(intake)
fallback           → create_task(front_desk)
```

All tool calls happen inside `withItemContext(item.id, ...)`. All 8 items are processed in
parallel with `Promise.allSettled` — a failed item produces a safe fallback output rather than
crashing the batch.

### Key safety decisions

- **item_2 (Maria Gomez)**: "dad getting rough" triggers P0 safeguarding. `escalate` is called
  before any outbound message. The draft is a neutral acknowledgement — no reference to the
  concern, no clinical or investigative framing.
- **item_3 (Owen Brooks, Kaiser)**: Insurance returns `out_of_network`. No slot is held. Billing
  task created first. This matches the policy: "benefits conversation required before any slot hold."
- **item_5 (Jordan Kim, R sounds)**: Classified `clinical_question`. `lookup_policy(clinical_advice)`
  is called. Draft redirects to booking a screening without answering the developmental question.
- **item_8 (Noah Patel, same-day cancel)**: P1. `search_patient` confirms existing record.
  `find_slots` + `hold_slot` run immediately so front desk has options ready.

## Failure Modes and Production Eval

**Failure modes I'm aware of:**

1. **Over-escalation**: If the LLM misreads a benign message as safeguarding, a family gets
   an unnecessary escalation. The system prompt includes "do not over-escalate" framing, but
   production would need a calibration eval against labeled examples.

2. **LLM JSON parse failure**: Handled by a fallback that returns `requires_human_review: true`
   and logs the error. In production, retry with temperature 0 before falling back.

3. **Insurance status mismatch**: `verify_insurance` is the system of record; the referral
   document may be stale. The agent trusts the tool result, which is the correct policy behavior.

4. **Slot race conditions**: `hold_slot` creates a 30-minute pending review hold. If two agents
   run concurrently on the same batch, the same slot could be held twice. Production needs
   idempotency keys tied to `item_id`.

5. **Language detection**: Spanish detection currently checks for "hola"/"llamo" in the body.
   A production system should use the LLM's extraction (a `language` field in the intake schema)
   rather than keyword heuristics.

**How I would evaluate in production:**
- Label a golden set of ~50 items with correct urgency, classification, and tool sequences
- Run the agent and score: urgency accuracy, P0 recall (must be ≥ 1.0), tool relevance, draft quality
- Track over-escalation rate separately — it is a production failure mode per the rubric

## What I Chose Not to Build, and Why

| Cut | Reason |
|-----|--------|
| Full agentic tool loop (let LLM pick tools) | Deterministic routing is more auditable and safer for P0 paths; LLM loop adds latency and unpredictability under time pressure |
| Retry logic with exponential backoff | Would add ~30 min; noted as a production gap above |
| Per-item language field in LLM schema | Worked around with body heuristics; acceptable for 2-hour scope |
| `hold_slot` for every in-network referral | Only hold when slots are found; avoids phantom holds on zero-slot results |
| Structured logging / observability | `console.error` only; production would use structured JSON logs with item_id |

## What I Would Do With Another 4 Hours

1. **Eval harness**: A `npm run eval` command that runs the agent against a labeled golden set and
   reports urgency accuracy, P0 recall, and tool precision. This is the most important missing piece.

2. **Idempotency**: Hash `item_id + content` and skip re-processing items already in output.
   Re-running the agent shouldn't create duplicate tasks or holds.

3. **Language field in extraction schema**: Add `detected_language` to the LLM output and use it
   to drive `find_slots(language)` and `draft_message(language)` instead of body heuristics.

4. **Cost + latency controls**: Cap max_tokens tighter per item, add a timeout per item (5s),
   and log token usage per run so a capped API key doesn't get exhausted silently.

5. **Richer draft replies**: Pass the tool results (slot times, hold IDs) back into a second LLM
   call to generate drafts that reference specific times — "We have a slot available Tuesday
   April 29 at 1pm" rather than a generic acknowledgement.
