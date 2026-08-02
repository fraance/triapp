# **TriApp — Adaptation Engine Logic v3**

**Purpose:** A decision system that produces a single, trustworthy, already-decided training day, every day, with zero cognitive load on the athlete. **Design North Star:** The athlete should never be asked a question they don't have new information to answer.

## **PART 1 — Architecture**

Plaintext

```
                     ┌──────────────────────────────────────┐
                      │   ATHLETE STATE STORE (source of truth)│
                      │  profile · baselines · load vectors ·  │
                      │  constraints · preferences · history   │
                      └──────────────┬───────────────────────┘
                                     │ (read-only)
     ┌───────────────┬───────────────┼───────────────┬───────────────┬───────────────┐
     ▼               ▼               ▼               ▼               ▼               ▼
┌─────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐
│READINESS│   │ PREDICTIVE│   │ EXECUTION │   │  WEATHER  │   │ LOGISTICS │   │   MACRO   │
│ SIGNALS │   │  ENGINE   │   │   DRIFT   │   │ & ENVIRON │   │ & CALENDAR│   │  PLANNER  │
└────┬────┘   └─────┬─────┘   └─────┬─────┘   └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
     └──────────────┴───────────────┴───────────────┴───────────────┴───────────────┘
                                     │  emit ONLY: Constraints + Preferences
                                     ▼
                      ┌──────────────────────────────────────┐
                      │        GUARDRAIL LAYER (hard)        │   ← inviolable
                      └──────────────┬───────────────────────┘
                                     ▼
                      ┌──────────────────────────────────────┐
                      │   SCHEDULER / SOLVER  (deterministic)│
                      │   constraint satisfaction + scoring  │
                      └──────────────┬───────────────────────┘
                                     ▼
                      ┌──────────────────────────────────────┐
                      │  DIFF ENGINE → hysteresis → commit   │
                      └──────────────┬───────────────────────┘
                        ┌────────────┴────────────┐
                        ▼                         ▼
             ┌────────────────────┐    ┌────────────────────┐
             │ NARRATOR (LLM)     │    │ SYNC OUTBOX        │
             │ change log / why   │    │ Garmin · Calendar  │
             └────────────────────┘    └────────────────────┘
                        │                         │
                        └──────► FEEDBACK LOOP ◄──┘
                             (accept/reject/override/execution)
```

**The Core Rule:** Signal engines are pure functions. They read state and return constraints. Only the Scheduler writes the plan. This guarantees determinism, testability, and a single place to reason about correctness.

## **PART 2 — Data Model**

### **2.1 Athlete Profile (Static \+ Slow-Moving)**

* **Demographics:** age, sex, weight, height.  
* **History:** years in sport, weekly hours baseline, injury sites and severities.  
* **Thresholds & Confidence:** Every threshold (FTP, CSS, vDOT) carries a confidence score that decays over time and rises with executions. Below 0.4, the engine prescribes in RPE and schedules a test.  
* **Metabolic State (v3 Enhancement):** Tracks estimated glycogen depletion based on trailing 48-hour load, converting this into fueling constraints.

### **2.2 Constraint Model**

Everything operates as typed constraints:

* **Types:** Hard (never violate) or Soft (weighted penalties).  
* **Kinds:** Equipment availability, time budgets, weather blackout, medical limits, and recovery separation.

### **2.3 Vectorized Load Tracking**

A single scalar TSS conflates too many variables. Load is tracked per-discipline across a 4-part vector:

1. **Metabolic:** Aerobic/systemic cost.  
2. **Mechanical Impact:** Eccentric damage (highest in running).  
3. **Neuromuscular:** High-intensity sprint work (slowest to recover).  
4. **Upper Body:** Swim-specific loading.

### **2.4 Event-Sourced Plan & The Baseline Rule**

* Plans consist of immutable PlanVersions.  
* Every change is a signed Adaptation event containing the cause, input hash, and plan diff.  
* This structure provides native auditability, A/B testing, and rollback capabilities.  
* **Data Baseline Retention:** Never completely overwrite a planned swim (or any session) with a completed ride deviation. If you permanently overwrite the scheduled activity, the engine loses its baseline and cannot calculate the delta between intent and reality. You must separate the UI from the database: in the UI, hide the missed session and only show the completed one. However, in the backend database, retain the 'Planned' session as a ghost record.

## **PART 3 — The Sliding Macro Planner (v3 Enhancement)**

Rather than generating an inflexible block once per week, the macro planner maintains a **rolling 21-day intent skeleton**. If the daily solver breaches a flexibility budget, the macro planner dynamically re-solves to adjust the phase intent immediately.

1. **Limiter Analysis:** Focus is allocated by ROI—disciplines are ranked by time lost vs. target on the A-race course.  
2. **Anchor Sessions:** Assigns 2–3 Key Sessions that must survive all daily adaptations.  
3. **Ramp Plan:** Weekly ramps are capped (≤ 5–8% CTL) with 3:1 or 2:1 load/recovery cycles.  
4. **Test Injection:** Triggered whenever threshold confidence drops below 0.5.

## **PART 4 — The Daily Decision Pipeline**

### **4.1 Stage 1 — Sense & Predict**

* Every biometric input (HRV, Sleep, Resting HR) is converted to a personal z-score against a rolling 60-day baseline before any rule evaluates it.  
* **Predictive Readiness (v3 Enhancement):** A time-series forecasting model predicts tomorrow's execution failure probability based on today's load vector, applying preemptive constraints before readiness officially crashes.

### **4.2 Stage 2 — Interpret (Signal Engines)**

Each engine is a pure function that emits constraints.

* **Readiness Engine:** Example: readiness\_z \< \-2.0 → HARD: no Z4/Z5 today; cap metabolic at 50%.  
* **Execution Drift Engine:** Evaluates planned vs. executed vectors and purpose achievement. Overshooting neuromuscular load by \>15% triggers a hard constraint against key sessions for 48 hours.  
* **Missed-Session Engine:** Computes a continuous Salvage Score based on purpose criticality, discipline ROI, phase relevance, and fatigue pressure. Depending on the score (\>0.7, 0.35–0.7, or \<0.35), the session is rescheduled, integrated into another workout, or dropped entirely.  
* **Environment Engine:** Continuous forecast polling emits a WEATHER\_BREACH\_PROBABILITY per session-window.

### **4.3 Stage 3 — Solve & Real-Life Anchoring**

A deterministic solver (e.g., CP-SAT) searches the next 7–10 days to maximize an objective function:

* **Maximizes:** Purpose fulfillment, load target adherence, preference alignment, and stability.  
* **Penalizes:** Soft constraint violations.  
* **Hard Boundaries:** No two Key Sessions of the same load component within 48 hours; heavy run must not precede heavy bike; long runs are immovable.  
* **The "Job" Problem Constraint:** Human beings have jobs, meaning rolling calculation windows cannot override real life. While using a rolling 7-day window for load calculation, permanently lock long-duration sessions (e.g., 2+ hours) to the user's pre-selected available days (typically weekends). If a rogue session spikes the rolling average on a Thursday, do not shift weekend volume to weekday mornings; trim weekday volume first.

### **4.4 Stage 4 — Commit (The Hysteresis Layer)**

* **Commitment Freeze Window:** At 20:00 local time, the next day's sessions lock and can only be altered by a safety guardrail or manual override.  
* **Hysteresis:** A change is only committed if the new plan score is materially better (new\_score \> current\_score × 1.08) to prevent notification thrash.  
* **Auto-Apply:** The engine decides and explains; it does not interrogate the user.

### **4.5 Stage 5 — Explain**

* Every adaptation triggers a structured rationale, passed to the LLM.  
* The LLM generates a natural language explanation strictly following: **cause → action → what it protects**.  
* *Example:* "Yesterday's ride was 25% harder than planned. Thursday's threshold run is now an easy base run — that keeps Sunday's long run intact, which matters more this week."

## **PART 5 — Guardrail Layer (Inviolable)**

This layer sits above the solver. No learned weight, preference, or drag-and-drop can breach these constraints. If you want an AI to act like a world-class coach, you cannot just tell it to "be smart." You have to build the fences it is allowed to be smart inside of. AI algorithms do not have intuition; they have parameters. Telling an AI to make abstract "executive coaching decisions" without a defined scoring matrix leads to wild AI hallucinations.

* **Ramp Rate:** Weekly load ≤ \+8% (≤ \+5% for mechanical impact).  
* **Acute:Chronic Workload (ACWR):** ACWR kept strictly between 0.8–1.3; blocked above 1.5. The mathematical formula is:  
   $$ACWR \= \\frac{\\text{Average Daily Load (Last 7 Days)}}{\\text{Average Daily Load (Last 28 Days)}}$$  
  **The "Cold Start" Trap:** If a user connects their data but only has 10 days of consistent history, the denominator (28 days) will be artificially low. The engine will calculate a massive ACWR spike and completely zero out their upcoming week. **Fallback:** If the athlete has less than 28 days of reliable chronic load data, ignore ACWR and govern the schedule using hard daily TSS ceilings based on their self-reported fitness level.  
* **Illness:** RHR \+7 bpm & HRV z \< \-1.5 for 2 days suspends training and prompts medical check.  
* **Session Separation:** ≥ 6 hours between same-day sessions unless explicitly marked as a brick.  
* **Cross-Sport Swap Penalty:** If a cross-sport swap occurs (e.g., running instead of swimming), apply a biomechanical fatigue penalty to the legs and restrict lower-body intensity for 48 hours. Never exceed the rolling 7-day TSS budget to make up for a missed sport.

## **PART 6 — Learning Layer**

* **Contextual Affinities:** Replaces scalar scalars with contextual bandits to learn P(accept | action\_type, context). A rejected indoor Sunday ride isolates sunday\_availability from indoor\_aversion.  
* **Biomechanical Durability (v3 Enhancement):** Models pace/power decay after N kilojoules, tailoring the mechanical impact constraints uniquely to the athlete's resilience threshold.  
* **Signal Weighting:** Learns which specific readiness inputs (e.g., HRV vs. Sleep) accurately predict execution quality for the specific user, weighting those signals accordingly.

## **PART 7 — LLM Boundaries**

The LLM is explicitly forbidden from computing load, scheduling, or evaluating guardrails. It is restricted to three locations:

1. **Narrator:** Translating the solver's struct into natural language.  
2. **Intent Parser:** Converting unstructured voice/text input into structured constraint modifications.  
3. **Conversational Coach:** Answering read-only QA against the athlete's historical event log.

