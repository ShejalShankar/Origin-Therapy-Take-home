import Anthropic from "@anthropic-ai/sdk";
import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  getToolCallsForItem,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
  withItemContext,
} from "./tools.js";
import type {
  Classification,
  Discipline,
  ExtractedIntake,
  InboxItem,
  ItemOutput,
  Urgency,
} from "./types.js";


const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// LLM extraction schema
interface LLMExtraction {
  classification: Classification;
  urgency: Urgency;
  requires_human_review: boolean;
  extracted_intake: ExtractedIntake;
  missing_info: string[];
  decision_rationale: string;
  recommended_next_action: string;
  draft_reply: string | null;
}


// System prompt
const SYSTEM_PROMPT = `You are an AI triage assistant for Cedar Kids Therapy, a multi-disciplinary
pediatric therapy practice (SLP, OT, PT). It is Monday 8am and you are processing the weekend inbox.

Your job is to extract structured intake data and make triage decisions. You must return ONLY valid
JSON matching the schema below — no markdown fences, no explanation outside the JSON.

URGENCY RULES (follow strictly):
- P0: safeguarding, imminent harm, mandated-reporter trigger. Same-hour human review.
- P1: same-day operational issue (e.g. today's appointment cancellation or reschedule).
- P2: normal intake, scheduling, billing, clinical-review workflow. DEFAULT.
- P3: low-priority admin, FYI, spam. Do not over-escalate.

CRITICAL SAFETY RULE: Any mention of physical harm, abuse, neglect, or unsafe caregiving toward a
child is P0 safeguarding, even if mentioned in passing or framed as background context.

CLINICAL ADVICE RULE: Never answer clinical questions. If a parent asks whether a symptom is normal
or requests clinical guidance, classify as clinical_question and redirect to booking a screening.
Do not provide developmental milestones or clinical opinions in draft_reply.

CLASSIFICATION RULE: You MUST use exactly one of these values for "classification":
"new_referral" | "existing_patient_request" | "scheduling" | "clinical_question" |
"billing_question" | "missing_paperwork" | "provider_followup" | "complaint" |
"safeguarding" | "spam" | "other"

HUMAN REVIEW RULE: requires_human_review MUST be true when:
- urgency is P0 or P1
- classification is "new_referral" or "existing_patient_request"
- insurance status is unknown, out_of_network, or expired
- any required intake field is missing
- classification is "safeguarding"
Only set requires_human_review to false for fully self-contained low-risk items (e.g. spam, P3 FYI).

DRAFT REPLY RULES:
- Be clear, empathetic, and concise.
- Never imply the message has been sent — it is a draft for staff review.
- Never provide clinical advice.
- For P0 safeguarding: draft only a neutral acknowledgement; do not reference the concern.
- For Spanish-language items: write draft_reply in Spanish.
- draft_reply may be null for items that need no outbound message (e.g. pure internal tasks).

Return JSON matching this exact schema:
{
  "classification": "new_referral" | "existing_patient_request" | "scheduling" | "clinical_question" | "billing_question" | "missing_paperwork" | "provider_followup" | "complaint" | "safeguarding" | "spam" | "other",
  "urgency": "P0" | "P1" | "P2" | "P3",
  "requires_human_review": true | false,
  "extracted_intake": {
    "child_name": "<string | null>",
    "dob_or_age": "<string | null>",
    "parent_contact": "<string | null>",
    "discipline": ["SLP" | "OT" | "PT"] | null,
    "diagnosis_or_concern": "<string | null>",
    "payer": "<string | null>",
    "member_id": "<string | null>"
  },
  "missing_info": ["<string>"],
  "decision_rationale": "<string>",
  "recommended_next_action": "<string>",
  "draft_reply": "<string | null>"
}`;


// LLM call for extraction and initial triage judgment
async function extractWithLLM(item: InboxItem): Promise<LLMExtraction> {
  const userMessage = `Inbox item ID: ${item.id}
Channel: ${item.channel}
Received: ${item.received_at}
Sender: ${item.sender}
Subject: ${item.subject}
Body:
${item.body}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  try {
    return JSON.parse(text) as LLMExtraction;
  } catch {
    return {
      classification: "other",
      urgency: "P2",
      requires_human_review: true,
      extracted_intake: {
        child_name: null,
        dob_or_age: null,
        parent_contact: null,
        discipline: null,
        diagnosis_or_concern: null,
        payer: null,
        member_id: null,
      },
      missing_info: ["LLM extraction failed — manual review required"],
      decision_rationale: "LLM returned non-JSON; defaulting to safe fallback.",
      recommended_next_action: "Staff should review this item manually.",
      draft_reply: null,
    };
  }
}

// Tool orchestration —  I have used a deterministic routing based on classification rather than delegating tool calls to the LLM.

async function orchestrateTools(
  item: InboxItem,
  llm: LLMExtraction,
): Promise<{ task_ids: string[]; escalation: ItemOutput["escalation"] }> {
  const task_ids: string[] = [];
  let escalation: ItemOutput["escalation"] = null;
  const intake = llm.extracted_intake;
  const receivedDate = new Date(item.received_at);
  const today = receivedDate.toISOString().split("T")[0];
  const nextBusinessDay = new Date(receivedDate.getTime() + 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
 

  //P0 SAFEGUARDING
  if (llm.classification === "safeguarding" || llm.urgency === "P0") {
    const esc = await escalate({
      item_id: item.id,
      reason: llm.decision_rationale,
      severity: "P0",
    });
    escalation = { reason: llm.decision_rationale, severity: "P0" };

    await lookup_policy({ topic: "safeguarding" });

    const task = await create_task({
      assignee: "clinical_lead",
      title: `SAFEGUARDING review required — ${item.id}`,
      due: today,
      notes: `Item ${item.id} contains potential safeguarding concern. Escalation ID: ${esc.data.escalation_id}. Clinical lead must review before any outbound contact.`,
    });
    task_ids.push(task.data.task_id);

    if (llm.draft_reply) {
      await draft_message({
        recipient: intake.parent_contact ?? "parent",
        channel: "phone",
        body: llm.draft_reply,
        language: "en",
      });
    }

    return { task_ids, escalation };
  }

  // P1 SAME-DAY CANCELLATION or RESCHEDULE
  if (llm.urgency === "P1" || llm.classification === "scheduling") {
    if (intake.child_name) {
      await search_patient({
        name: intake.child_name,
        dob: intake.dob_or_age ?? undefined,
      });
    }

    // Find replacement slots
    if (intake.discipline && intake.discipline.length > 0) {
      const slots = await find_slots({
        discipline: intake.discipline[0],
        preferences: "earliest available",
      });

      // Hold the earliest slot for staff review
      if (slots.data.length > 0) {
        await hold_slot({
          slot_id: slots.data[0].slot_id,
          patient_ref: intake.child_name ?? item.id,
        });
      }
    }

    const task = await create_task({
      assignee: "front_desk",
      title: `Same-day reschedule needed — ${intake.child_name ?? item.id}`,
      due: today,
      notes: `Parent requested reschedule for today's appointment. Review held slot and confirm with family.`,
    });
    task_ids.push(task.data.task_id);

    if (llm.draft_reply) {
      await draft_message({
        recipient: intake.parent_contact ?? "parent",
        channel: "email",
        body: llm.draft_reply,
        language: "en",
      });
    }

    return { task_ids, escalation };
  }

  // CLINICAL QUESTION 
  if (llm.classification === "clinical_question") {
    await lookup_policy({ topic: "clinical_advice" });

    if (llm.draft_reply) {
      await draft_message({
        recipient: intake.parent_contact ?? "parent",
        channel: "portal",
        body: llm.draft_reply,
        language: "en",
      });
    }

    return { task_ids, escalation };
  }

  // INCOMPLETE REFERRAL or any MISSING PAPERWORK
  if (
    llm.classification === "missing_paperwork" ||
    llm.missing_info.length >= 3
  ) {
    const task = await create_task({
      assignee: "intake",
      title: `Incomplete referral — follow up with referring provider for ${intake.child_name ?? item.id}`,
      due: nextBusinessDay,
      notes: `Missing fields: ${llm.missing_info.join(", ")}. Contact referring office to complete intake.`,
    });
    task_ids.push(task.data.task_id);

    return { task_ids, escalation };
  }

  // NEW REFERRAL or EXISTING PATIENT REQUEST
  if (
    llm.classification === "new_referral" ||
    llm.classification === "existing_patient_request"
  ) {
    // 1. Search for existing patient record
    if (intake.child_name) {
      await search_patient({
        name: intake.child_name,
        dob: intake.dob_or_age ?? undefined,
      });
    }

    // 2. Verify insurance
    let insuranceStatus = "unknown";
    if (intake.payer) {
      const ins = await verify_insurance({
        payer: intake.payer,
        member_id: intake.member_id ?? undefined,
      });
      insuranceStatus = ins.data.status;

      // 3a. Out-of-network or expired — billing task, no slot
      if (
        insuranceStatus === "out_of_network" ||
        insuranceStatus === "expired"
      ) {
        await lookup_policy({ topic: "insurance" });

        const task = await create_task({
          assignee: "billing",
          title: `Insurance issue for ${intake.child_name ?? item.id} — ${insuranceStatus}`,
          due: nextBusinessDay,
          notes: `${intake.payer} returned status: ${insuranceStatus}. Parent must have benefits conversation before any slot is held.`,
        });
        task_ids.push(task.data.task_id);

        if (llm.draft_reply) {
          await draft_message({
            recipient: intake.parent_contact ?? "parent",
            channel: "email",
            body: llm.draft_reply,
            language: "en",
          });
        }

        return { task_ids, escalation };
      }
    }

    // 3b. Insurance OK (or unknown) — find and hold a slot
    if (intake.discipline && intake.discipline.length > 0) {
      const isSpanish = item.body.toLowerCase().includes("hola") ||
        item.body.toLowerCase().includes("llamo") ||
        item.channel === "voicemail_transcript" && item.body.includes("espanol");

      const slots = await find_slots({
        discipline: intake.discipline[0] as Discipline,
        preferences: "evaluation",
        language: isSpanish ? "es" : undefined,
      });

      if (slots.data.length > 0) {
        await hold_slot({
          slot_id: slots.data[0].slot_id,
          patient_ref: intake.child_name ?? item.id,
        });
      }
    }

    // 4. Create intake task
    const task = await create_task({
      assignee: "intake",
      title: `New referral intake — ${intake.child_name ?? item.id}`,
      due: nextBusinessDay,
      notes: `Discipline: ${intake.discipline?.join(", ") ?? "unknown"}. Insurance: ${intake.payer ?? "unknown"} (${insuranceStatus}). Review held slot and confirm with family.`,
    });
    task_ids.push(task.data.task_id);

    // 5. Draft outbound message
    if (llm.draft_reply) {
      const isSpanishSpeaker =
        item.body.toLowerCase().includes("hola") ||
        item.body.toLowerCase().includes("llamo");

      await draft_message({
        recipient: intake.parent_contact ?? "parent",
        channel: intake.parent_contact?.includes("@") ? "email" : "phone",
        body: llm.draft_reply,
        language: isSpanishSpeaker ? "es" : "en",
      });
    }

    return { task_ids, escalation };
  }

  //FALLBACK for other classifications
  const task = await create_task({
    assignee: "front_desk",
    title: `Review required — ${item.id}`,
    due: nextBusinessDay,
    notes: `Classification: ${llm.classification}. ${llm.recommended_next_action}`,
  });
  task_ids.push(task.data.task_id);

  if (llm.draft_reply) {
    await draft_message({
      recipient: intake.parent_contact ?? "parent",
      channel: "email",
      body: llm.draft_reply,
      language: "en",
    });
  }

  return { task_ids, escalation };
}

// Process a single inbox item
async function processItem(item: InboxItem): Promise<ItemOutput> {
  return withItemContext(item.id, async () => {
    const llm = await extractWithLLM(item);
    const { task_ids, escalation } = await orchestrateTools(item, llm);
    const tools_called = getToolCallsForItem(item.id);

    return {
      item_id: item.id,
      classification: llm.classification,
      urgency: llm.urgency,
      requires_human_review: llm.requires_human_review,
      extracted_intake: llm.extracted_intake,
      missing_info: llm.missing_info,
      tools_called,
      recommended_next_action: llm.recommended_next_action,
      draft_reply: llm.draft_reply,
      task_ids,
      escalation,
      decision_rationale: llm.decision_rationale,
    };
  });
}

//  The Main entry point to run the the agent
export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  // Process all items in parallel — tools are per-item and don't share state
  const results = await Promise.allSettled(inbox.map(processItem));

  return results.map((result, i) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    console.error(`Error processing ${inbox[i].id}:`, result.reason);
    return {
      item_id: inbox[i].id,
      classification: "other" as const,
      urgency: "P2" as const,
      requires_human_review: true,
      extracted_intake: {
        child_name: null,
        dob_or_age: null,
        parent_contact: null,
        discipline: null,
        diagnosis_or_concern: null,
        payer: null,
        member_id: null,
      },
      missing_info: ["Agent error — manual review required"],
      tools_called: getToolCallsForItem(inbox[i].id),
      recommended_next_action: "Staff should review this item manually.",
      draft_reply: null,
      task_ids: [],
      escalation: null,
      decision_rationale: `Processing error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
    };
  });
}
