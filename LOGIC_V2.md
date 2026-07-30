# TriApp — Adaptive Coaching Logic V2

**Status:** Proposed — supersedes `Logic.txt` (V1)
**Audience:** Product + Engineering + the athlete (you)
**Framing:** Written as a professional triathlon coach would specify their own decision-making, then made machine-executable.

---

## PART 0 — WHY V2 EXISTS: CRITIQUE OF V1

V1 is genuinely good on *reactive* logic. It fails on five things that matter more.

### 0.1 There is no generation engine, only a reaction engine
V1 describes exhaustively what to do when a plan is disturbed. It never describes **how the plan came to exist**. There is no macrocycle → mesocycle → microcycle construction, no phase model, no intensity-distribution policy, no progression rules, no taper, no race week, no post-race. An adaptation engine without a periodisation engine is a very smart way of rearranging a plan that may be wrong to begin with.

**Fix:** Part 2 (Plan Generation) is the new spine. Adaptation is downstream of it.

### 0.2 TSS is used as a universal currency. It is not.
V1 moves "load" between disciplines and days as if 60 TSS of running, cycling and swimming were fungible. They are not:
- 60 rTSS carries large **eccentric/mechanical** cost (bone, tendon, connective tissue).
- 60 bTSS carries metabolic and neuromuscular cost but near-zero mechanical cost.
- 60 sTSS is largely a shoulder/technique/aerobic stimulus, and swim TSS is the least reliable number in the sport.

Consequence: "Rule 4 — redistribute missed TSS into the weekend long sessions" is, in my professional opinion, the single most dangerous rule in V1. It inflates the two largest, highest-risk sessions of the week to repay a debt that does not need repaying. That is how age-groupers get Achilles tendinopathy and stress reactions.

**Fix:** Part 1.3 introduces **three parallel load currencies** (Metabolic, Mechanical, Neuromuscular) plus discipline-specific caps. Part 4.4 rewrites missed-session handling with **debt forgiveness as the default**.

### 0.3 Every session in V1 is equally important, so nothing is
V1 invents "Key Sessions" only at the moment it needs to protect them (day-swap rules). That is too late and too fuzzy.

**Fix:** Part 1.2 — **every session is stamped at generation time with a Priority Tier (P1/P2/P3) and an explicit Physiological Intent**. Every downstream decision (move, trim, drop, blend) becomes a trivial lookup instead of an LLM judgement call. This is the highest-leverage change in the document.

### 0.4 The UX contract defeats the product goal
V1's flow is: engine proposes → athlete accepts/rejects → micro-prompt asks why. That is *more* thinking, not less. Weather engine, readiness engine and execution engine can each fire independently, so you could face three approval dialogs before breakfast. And there is no arbitration when two engines want to change the same Thursday.

**Fix:** Part 5 — **The Arbiter**: one single authority, one daily write window, one plan version. Part 6 — an **Autonomy Ladder**: changes are silently auto-applied, notified, or escalated based on magnitude. Target: the athlete confirms something roughly **once every 10–14 days**, not daily.

### 0.5 Physiological gaps a coach would immediately flag
Missing entirely or nearly: strength training in the adaptation logic; swim **frequency** (not volume) as the governing variable; brick and race-specific work; durability / fatigue-resistance; heat and altitude; illness and injury protocols; return-to-run progression; taper; race week; post-race; travel; monotony/strain; intensity distribution governance; execution *quality* (V1 only measures TSS delta, never whether the athlete actually hit the target zones).

Also: the menstrual-cycle logic is stated with more confidence than the evidence supports. Group-level phase effects are small and highly individual. Deterministic phase rules will be wrong for many athletes.

**Fix:** Part 3.5 replaces phase-determinism with a **symptom-driven, personally-calibrated** model.

### 0.6 Two incompatible preference models
`Logic.txt` uses an Affinity Score (0.0–1.0). The TDD uses Elo (1200-ish). Pick one.

**Fix:** Part 7 — Elo-style pairwise ratings, **contextualised** (an athlete does not hate the trainer universally; they hate it for 3-hour rides in June).

---

## PART 1 — DOMAIN MODEL

Everything downstream depends on these primitives. Get them right and the rest is bookkeeping.

### 1.1 The Athlete State Vector
Recomputed nightly (03:00 local). Single source of truth for all engines.

| Field | Definition | Window |
|---|---|---|
| `ctl_total` | Exponentially weighted chronic load | 42 d |
| `atl_total` | Exponentially weighted acute load | 7 d |
| `tsb` | `ctl − atl` (yesterday's values) | — |
| `ctl_run`, `ctl_bike`, `ctl_swim` | Per-discipline CTL | 42 d |
| `mechanical_load_7d` | Weighted impact load (see 1.3) | 7 d |
| `mechanical_load_28d` | Chronic mechanical baseline | 28 d |
| `acwr_mechanical` | `mech_7d / (mech_28d / 4)` | — |
| `ramp_rate` | ΔCTL over trailing 7 d | 7 d |
| `monotony` | `mean(daily load) / SD(daily load)` (Foster) | 7 d |
| `strain` | `weekly load × monotony` | 7 d |
| `intensity_ratio` | % of weekly *duration* below LT1 | 7 d & 28 d |
| `hrv_baseline` | Rolling mean of ln(rMSSD) | 60 d |
| `hrv_swc` | `0.5 × SD(hrv_baseline)` | 60 d |
| `hrv_7d` | Rolling 7-day mean of ln(rMSSD) | 7 d |
| `rhr_baseline` / `rhr_7d` | Resting HR | 60 d / 7 d |
| `sleep_debt` | Σ(need − actual), decayed 20 %/night | 7 d |
| `compliance_28d` | Mean execution quality score (see 4.2) | 28 d |
| `swim_frequency_14d` | Count of swim sessions | 14 d |
| `durability_index` | Δ in HR:power decoupling, hour 1 vs hour 3 | best of 42 d |
| `phase` | base / build / peak / taper / race / recovery | — |
| `weeks_to_A_race` | — | — |

**Rule:** No engine may query raw Garmin data directly. They read the State Vector. This keeps adaptation deterministic and testable.

### 1.2 Session Object — the critical upgrade
Every generated session, forever, carries this. No exceptions.

```jsonc
{
  "id": "uuid",
  "date": "2026-08-04",
  "discipline": "run",
  "priority": "P1",              // P1 | P2 | P3  — see below
  "intent": "vo2max",            // controlled vocabulary, see 1.4
  "duration_min": 62,
  "load": { "metabolic": 78, "mechanical": 61, "neuromuscular": 55 },
  "intensity_minutes": { "z1_2": 40, "z3": 4, "z4": 6, "z5": 12 },
  "structure": [ /* Garmin-pushable steps with zone targets */ ],
  "flex": {
    "movable_days": 2,           // ± days this may be shifted
    "trimmable_pct": 25,         // max duration reduction before intent is lost
    "indoor_ok": true,
    "blendable_into": ["run:endurance"],   // for stimulus integration
    "substitutes": ["bike:vo2max"]         // if discipline must change
  },
  "why": "Raises VO2max ceiling. Only P1 run this week.",
  "locked_by": null              // "athlete" | "arbiter" | null
}
```

**Priority Tiers — the whole adaptation model rests on these:**

| Tier | Meaning | Adaptation rights |
|---|---|---|
| **P1** | Session the week exists for. Typically 2–3/week. | Never dropped. May move ±2 d, may be trimmed ≤15 %, may go indoor. If it cannot survive, the Arbiter reshapes *other* sessions to save it. |
| **P2** | Supports the P1s. Aerobic volume, technique, strength. | May move, trim ≤40 %, convert discipline, or be dropped if it threatens a P1. |
| **P3** | Optional. Recovery spins, mobility, extra easy volume. | Dropped silently and without debt. Never triggers a notification. |

Every week is generated with a declared **Week Intent** (e.g. "Bike threshold + run durability, swim maintenance") and 2–3 P1s that deliver it. When life happens, the engine asks one question: *does this still deliver the Week Intent?* — not "where do I put these 45 minutes?"

### 1.3 Three load currencies

**Metabolic load** — classic TSS per discipline (bTSS from power, rTSS from pace/GAP, sTSS from CSS). Drives CTL/ATL/TSB. Fungible across disciplines *for aerobic accounting only*.

**Mechanical load** — the injury currency. Discipline-weighted:

```
mechanical = duration_min × impact_coefficient × pace_factor × surface_factor
```
| Activity | impact_coeff |
|---|---|
| Run — hard surface | 1.00 |
| Run — trail/soft | 0.85 |
| Run — treadmill | 0.90 |
| Plyometric / strides | 1.40 |
| Bike outdoor | 0.15 |
| Bike indoor | 0.12 |
| Strength (lower body, loaded) | 0.60 |
| Swim | 0.05 |

`pace_factor`: 1.0 at easy pace, up to 1.35 at ≥ threshold, 1.5 for max-effort strides.
Mechanical load is **never transferable between disciplines**. A missed run cannot be repaid with a ride.

**Neuromuscular load** — CNS/systemic cost. High for VO2max, sprints, heavy lifting, long bricks. Governs the 48-hour density rules (Part 2.5) better than TSS does, because a 45-min VO2max session and a 3-hour Z2 ride can have identical TSS and completely different recovery requirements.

### 1.4 Controlled vocabulary for `intent`
`recovery` · `aerobic_base` · `long_endurance` · `tempo` · `threshold` · `vo2max` · `anaerobic` · `neuromuscular_speed` · `technique` · `race_pace` · `brick` · `open_water` · `strength_max` · `strength_power` · `strength_endurance` · `mobility` · `test`

The Arbiter reasons over `intent`, never over free text. This is what stops the LLM from hallucinating equivalences ("a tempo run is basically threshold, right?" — no).

---

## PART 2 — PLAN GENERATION ENGINE (missing from V1)

Runs on: onboarding, race added/changed, phase transition, or a forced re-plan (max 1/week).

### 2.1 Macrocycle
Input: A-race date, distance, course profile, current State Vector, athlete history, weekly hour availability.

1. Count weeks to A-race.
2. Allocate phases by remaining weeks:

| Weeks available | Allocation |
|---|---|
| ≥ 24 | Base 45 % · Build 30 % · Peak 12 % · Taper 8 % · Race week 5 % |
| 16–23 | Base 35 % · Build 38 % · Peak 14 % · Taper 8 % · Race 5 % |
| 10–15 | Base 20 % · Build 48 % · Peak 15 % · Taper 12 % · Race 5 % |
| < 10 | "Prep to finish safely" mode — volume consolidation + race-specific only, no VO2max blocks |

3. Set **peak CTL target**: from historical max CTL, capped at `+25 %` of the athlete's best previous 42-day CTL. Never invent a target that requires ramp > 5 CTL/week sustained.
4. Back-solve required weekly load to arrive at peak CTL with TSB in the +5 to +25 band on race day.
5. Insert B/C races as **key workouts + mini-taper (3 d) + 3 d recovery**, never as full tapers.

### 2.2 Mesocycle
Default 3:1 (three loading weeks, one recovery week at 55–65 % load). Switch to **2:1 automatically** if any of:
- age > 45, or
- `compliance_28d < 0.8`, or
- HRV suppression events ≥ 2 in trailing 21 days, or
- injury history flag active.

Each mesocycle declares a **Block Focus** (e.g. "Bike threshold + swim frequency"). The focus discipline gets +1 quality session; the others go to maintenance.

**Maintenance doctrine (this is what keeps a busy age-grouper unbroken):** a discipline in maintenance needs *frequency and intensity*, not volume. 2× short + 1 quality session per week retains ~90 % of fitness. The engine never tries to progress all three sports simultaneously.

### 2.3 Microcycle (the week)
Constraints applied in this order — **hard rails first, preferences second**:

**Hard rails (never violated, even by the athlete's manual drag-and-drop):**
- H1. Weekly `mechanical_load` increase ≤ 10 % w/w (≤ 6 % if injury history, ≤ 5 % if returning from > 14 d off).
- H2. `acwr_mechanical` must stay in [0.80, 1.35].
- H3. `ramp_rate` (ΔCTL/week) ≤ 6 for build, ≤ 8 for a deliberate overload week (max 2 consecutive).
- H4. Long run ≤ 30 % of weekly run duration.
- H5. Long ride ≤ 45 % of weekly bike duration.
- H6. ≥ 1 full rest day per 9 days. Non-negotiable.
- H7. Intensity distribution: ≥ 78 % of weekly *duration* below LT1 in base; ≥ 72 % in build/peak.
- H8. Max 3 sessions/week containing > 8 min above LT2 (2 in base).
- H9. `monotony` < 2.0. If breached, the engine deliberately makes easy days easier and hard days harder rather than reducing volume.
- H10. Total weekly hours ≤ athlete's declared availability minus a 12 % buffer.

**Placement heuristics:**
- P1 sessions land on the athlete's historically highest-compliance days (learned from 12 weeks of data — this alone lifts adherence more than any algorithmic cleverness).
- Swim frequency ≥ 3×/week whenever the athlete's swim is their limiter; frequency beats duration for adult-onset swimmers because technique decays within ~5 days.
- Strength: 2×/week in base, 1×/week in build/peak, 0 in the last 10 days before an A-race. Lower-body strength never within 24 h *before* a P1 run and never within 36 h before a long run.
- Long ride and long run separated by ≥ 24 h during base; deliberately stacked (ride → next-morning run) during build to train durability.

### 2.4 Progression rules per discipline
- **Run:** duration first, then frequency, then intensity. Never two of the three in the same week.
- **Bike:** intensity and duration may progress together (low mechanical cost), but not in a week with a run-volume increase.
- **Swim:** frequency first, then set density (shorter rest), then volume. Threshold swim volume progresses ≤ 100 m per week per set.

### 2.5 Density rules (replaces V1's "48-Hour Density Cap")
V1's rule — never two Key Sessions back-to-back — is too blunt; it forbids legitimate and valuable stacking. Replace with a **neuromuscular-cost check**:

```
allowed( day_n, day_n+1 ) =
    NOT ( nm_load(n) > 60 AND nm_load(n+1) > 60 )
AND NOT ( mechanical(n) > 70 AND mechanical(n+1) > 70 )
AND NOT ( intent(n) == vo2max AND intent(n+1) IN {vo2max, anaerobic} )
```
Plus the biomechanical ordering rules V1 got right, kept and made explicit:
- Hard **run** → hard **bike** next day: **forbidden** (eccentric damage destroys power output).
- Hard **bike** → hard **run** next day: **allowed and encouraged in build** (this is durability training).
- Hard **bike/run** → hard **swim**: allowed.
- Hard **swim** → hard **anything**: allowed (except a swim-focus block, where the swim is the P1).

---

## PART 3 — READINESS ENGINE

Runs 04:30 local, before the athlete wakes. Output: a single `readiness_score` ∈ [0,100] plus a `readiness_band`.

### 3.1 Composite score, not single triggers
V1's "sleep < 6 h → downgrade to Z2" is too brittle: one bad night after a great fortnight is a non-event; three bad nights on top of a high ramp is a red flag. Use a weighted composite with **objective data dominant** (it does not require the athlete to think — which is the whole point of the product):

| Input | Weight | Notes |
|---|---|---|
| HRV: `hrv_7d` vs `hrv_baseline`, in SWC units | 30 % | Rolling 7-day vs 60-day. Never single-morning values. |
| Sleep (last night duration × quality) | 20 % | |
| `sleep_debt` (7 d) | 10 % | |
| RHR deviation from baseline | 10 % | > +5 bpm is meaningful |
| TSB | 15 % | |
| Subjective check-in (see 3.3) | 15 % | Optional — weights redistribute if skipped |

### 3.2 Bands and actions

| Band | Score | Action |
|---|---|---|
| **Green** | ≥ 70 | Execute as planned. If ≥ 85 AND TSB > −10 AND a P1 is scheduled, offer a **Push** (+1 interval or +10 % duration, never both). |
| **Amber** | 50–69 | Preserve intent, reduce dose: cut interval *count* by 20–25 %, keep target zones intact, extend recoveries by 20 %. Never convert a P1 to Z2 at this band — do less of the right thing rather than more of the wrong thing. |
| **Orange** | 35–49 | Convert P1 → aerobic equivalent at same duration. Reschedule the P1 within 72 h if the week can absorb it, otherwise sacrifice it. Drop all P3. |
| **Red** | < 35 | Rest or 20–30 min recovery movement, athlete's choice. Auto-trigger a check-in: illness? |

**Hysteresis:** requires 2 consecutive days in a band before a *downward* structural change (prevents thrash), but only 1 day for an *upward* release. Red acts immediately.

**Escalation:** 3 consecutive Orange/Red days, or `hrv_7d` below `baseline − 1.0 SWC` for 5 of 7 days → force an unplanned recovery week and notify. This is the non-functional-overreaching guard V1 lacks entirely.

### 3.3 Subjective check-in — 8 seconds, max
Three taps, and only shown if objective data is ambiguous or missing:
- Legs: fresh / normal / heavy / sore *(+ tap body map if sore)*
- Motivation: high / normal / low
- Anything else? *(chips: poor sleep · alcohol · stress · travel · illness · time-crunched · sore throat)*

Chip effects:
- **alcohol** (any) → suppress `vo2max`/`anaerobic` for 24 h, +10 min warm-up, cap HR at LT2 (alcohol impairs REM, elevates RHR and blunts glycogen resynthesis). ≥ 3 units → treat as Orange.
- **time-crunched** → this is the highest-frequency real-world event and V1 ignores it. Engine returns a **compressed version of the same session preserving intent**: cut warm-up/cool-down and P3 volume first, protect main set last. A 60-min threshold run becomes a 35-min session with the same threshold minutes, not an easy 35-min jog.
- **sore throat / illness** → apply neck-check rule (3.4).
- **travel** → Part 8.3.

### 3.4 Soreness and illness protocols (mostly absent from V1)
**Soreness triage** using the body map:
- DOMS-pattern (bilateral, diffuse, 24–48 h post, eases with warm-up) → proceed, reduce mechanical load 20 %.
- Localised + unilateral + tendon/bone site (Achilles, tibia, plantar, patellar, hip) → **run is removed, not swapped-and-forgotten**. Substitute equal-metabolic-load bike or aqua-run. Start a 3-day monitoring flag. Two flags in 14 d → recommend professional assessment and cap run mechanical load at 70 % for 2 weeks.
- Pain rule for anything ongoing: allowed if ≤ 3/10, does not increase during session, and is not worse the following morning. Otherwise stop.

**Illness — neck check:**
- Symptoms above the neck only, no fever → Z1–Z2 only, ≤ 45 min, no intensity.
- Below the neck, fever, body aches, or resting HR > +10 bpm → **zero training**, and no return until 24 h symptom-free.
- Return-to-train ladder: 2 days easy at 50 % duration → 2 days easy at 75 % → reintroduce intensity on day 5. CTL is allowed to fall. It always comes back faster than it left.

### 3.5 Menstrual cycle — personalised, not deterministic
Replace V1's fixed phase rules. Group-level phase effects on performance are small and inconsistent; symptom burden is what actually matters and it is highly individual.

- **Months 1–3:** track only. Log cycle day + symptoms (3 taps). Make no plan changes beyond the standard readiness engine. Nothing is more damaging to trust than the app downgrading a session for a phase that doesn't affect this athlete.
- **From month 4:** run a per-athlete regression of `readiness`, `compliance` and `execution_quality` against cycle phase. Only apply phase-based rules where the effect exceeds noise for *this* athlete.
- Rules that are safe to apply universally because they are thermoregulatory, not performance claims:
  - Late luteal + forecast heat index > 26 °C → prefer indoor or early-morning for sessions > 75 min, extend recoveries 15 %, raise hydration prompt.
  - Heavy-flow days flagged by the athlete → auto-demote P1 by one tier, offered not imposed.
- Always framed as an offer with a one-tap "I feel great, keep it" override, which itself feeds the regression.

---

## PART 4 — EXECUTION ENGINE

Fires on Garmin webhook, ≤ 5 min after upload.

### 4.1 Two deltas, not one
V1 measures only load delta. That misses the more informative signal.

- **Volume/load delta** = `executed_load / planned_load`
- **Execution quality** = did the athlete hit the *targets*?

### 4.2 Execution Quality Score (0–1)
```
EQ = 0.40 × zone_adherence      # % of main-set time in the prescribed zone band
   + 0.25 × interval_completion # completed reps / prescribed reps
   + 0.20 × decoupling_penalty  # 1 − normalised HR:pace(power) drift within main set
   + 0.15 × durability          # ratio of last-interval to first-interval output
```
This is what a coach actually looks at. It distinguishes three cases V1 collapses into one:
- **Overshot the target zones** (rode the "easy" ride at tempo) → the classic grey-zone error. Trigger a coaching nudge, not a plan change: *"That Z2 ride averaged Z3. Easy days easy is what makes hard days possible."* Track `grey_zone_index`; if > 25 % of easy sessions for 3 weeks, the engine starts prescribing **HR-capped** sessions with an alert on the watch.
- **Undershot but completed** → possible fitness overestimate → see 4.5.
- **Failed to complete** → fatigue or life. Feed readiness.

### 4.3 Response matrix

| Case | Condition | Action |
|---|---|---|
| **Over-reached** | load > 130 % of plan **or** EQ high with `nm_load` > 130 % | Next 48 h: demote highest `nm_load` session by one intensity step. Recompute weekly caps. If ramp_rate now > H3 limit, force the next planned recovery week 1 week early. |
| **Grey zone** | intent ∈ {recovery, aerobic_base} AND zone_adherence < 0.6 upward | No plan change. Coaching note. Increment `grey_zone_index`. |
| **Under-reached, P1** | EQ < 0.7 on a P1 | Do **not** reschedule the same stimulus within 72 h. Ask: fatigue (readiness was low → accept, move on) or fitness (zones may be wrong → 4.5). |
| **Under-reached, P2/P3** | — | Ignore. No debt. Easy is meant to be easy. |
| **Exceeded** | EQ ≥ 0.95 with power/pace above prescribed at same HR for 3 sessions | Flag for threshold re-estimation (4.5). |

### 4.4 Missed sessions — rewritten
V1's four rules are directionally right but repay debt too aggressively. Corrected hierarchy, evaluated top-down, **stop at first match**:

1. **P3 missed** → deleted silently. No log entry, no notification, no debt. *(Reduces notification volume by roughly half.)*
2. **P2 missed, readiness Amber or worse, or TSB < −20** → deleted. Log line only: *"Dropped Tuesday's easy ride — you're carrying fatigue and Saturday matters more."*
3. **P2 missed, athlete fresh, and slot exists within 3 days without breaching a hard rail** → move it. Otherwise delete.
4. **P1 missed** → attempt in this order:
   a. **Move** within ±2 days if density and hard rails permit.
   b. **Blend** into a compatible upcoming session via `flex.blendable_into` — but only up to **60 % of the original main-set volume**, and only if the host session is P2 or lower. V1's "fold the whole missed set into tomorrow" creates an unplanned overload day.
   c. **Substitute discipline** via `flex.substitutes` if the limiter is mechanical (e.g. missed run VO2max → bike VO2max preserves the central stimulus at zero impact cost). Excellent option that V1 never considers.
   d. **Sacrifice.** Log it and move on. One missed P1 in a 3:1 mesocycle changes nothing measurable.
5. **Two or more P1s missed in one week** → do not attempt recovery. Convert the week to a recovery week and restate the block. This is the difference between a coach and a scheduler.

**Load debt is forgiven by default.** The engine never adds volume to the long ride or long run to repay missed midweek sessions. The only exception: if weekly volume falls > 25 % below plan for 2 consecutive weeks, the *plan* is regenerated at a lower level rather than the athlete being asked to catch up. Chasing a plan you can't hold is how age-groupers get hurt.

### 4.5 Continuous threshold estimation (replaces forced testing)
V1 injects an FTP test into the first weekend. Better: **derive thresholds from training data and only test when confidence is low.**

- **Bike:** mFTP from the 42-day power-duration curve (critical power model over 3/5/8/12/20-min bests). Confidence = f(recency, spread of durations).
- **Run:** rVDOT from best efforts ≥ 10 min, GAP-corrected, HR-cross-validated.
- **Swim:** CSS regressed from any set containing ≥ 2 distances (400/200, 400/100, 200/50…) inside normal training — no test day needed.
- **Auto-update** when confidence ≥ 0.7 and the new estimate differs > 3 %. Notify: *"Your bike threshold moved 258 → 268 W based on Tuesday's session. Zones updated."*
- **Schedule a real test** only when confidence < 0.5 for > 21 days, or at each phase transition. Place it as a P1 on a Green-readiness day, never on a fixed calendar date.
- Cold start (no data at all): week 1 runs on **RPE + HR-only** with conservative durations, plus an embedded ramp/step protocol inside an otherwise normal session. Retro-stamp all future zones.

---

## PART 5 — THE ARBITER (new — the missing piece)

V1 has four engines that can all mutate the calendar with no coordination. This is the number-one source of the "app feels chaotic / I don't trust it" failure mode.

### 5.1 Rules
1. **Single writer.** Readiness, Execution, Environment and Athlete-Manual engines emit *proposals*, never writes. Only the Arbiter writes to the plan.
2. **One daily write window** at 04:45 local. All overnight proposals are batched, resolved and applied as one atomic plan version. Exceptions permitted to interrupt: Red readiness, illness flag, severe weather safety, athlete manual edit.
3. **Versioned plans.** Every write creates `plan_version = n+1` with a diff and a plain-English rationale. Any version is one-tap revertible for 7 days.
4. **Rolling horizon.** The Arbiter may only modify **today → today+9**. Beyond that, the macrocycle owns the plan. This stops far-future churn and makes the plan feel stable.
5. **Change budget.** Max 3 session-level changes per day and 8 per rolling 7 days (excluding silent P3 drops). If proposals exceed the budget, the Arbiter escalates to a **full week re-plan** instead of dribbling out changes — one decision instead of eight.

### 5.2 Conflict precedence
When two engines target the same session, the higher precedence wins and the loser is re-evaluated against the new state:

```
1. Safety / injury / illness       (hard veto over everything)
2. Athlete manual lock             (respected, but see 5.3)
3. Readiness engine
4. Execution engine
5. Environment / weather engine
6. Preference optimiser
```
Weather is deliberately **lowest**. V1 lets rain reshuffle the physiology of the week. Wrong priority order: rain is an inconvenience, fatigue is a risk.

### 5.3 Athlete overrides
The athlete may always override. The Arbiter then:
- Simulates the resulting week against hard rails H1–H10.
- If no rail breaks: apply silently. Say nothing. *(This is the "no thinking" contract.)*
- If a rail breaks: apply the change anyway, but auto-compensate elsewhere and state it in one line — *"Moved. I've cut Tuesday's tempo to easy so you're not doing back-to-back hard runs."*
- Never block. Never nag. Log the override as a preference signal (Part 7).

### 5.4 Invariants — assert on every write
The plan is rejected and rolled back if any of these fail. These are the automated tests for the coaching engine:
- H1–H10 hold for the rolling 9-day window.
- No day exceeds `max_daily_load_historical × 1.15`.
- ≥ 1 rest day in every 9-day window.
- No P1 within 48 h of a test or B-race.
- The weekly long run is never shortened or moved to accommodate a displaced bike session *(V1 got this right — kept verbatim)*.
- Every session pushed to Garmin has valid structured targets and a non-empty `why`.

---

## PART 6 — THE "NO THINKING" CONTRACT

This is the product, not a feature. Specified as strictly as the physiology.

### 6.1 Autonomy ladder

| Level | Change magnitude | Behaviour |
|---|---|---|
| **L0 — Silent** | P3 drops; ±10 % duration; warm-up changes; indoor/outdoor swap of an easy session; time-of-day shift | Just do it. Visible in the change log only if the athlete goes looking. |
| **L1 — Notified** | Intensity step change; P2 move or drop; ±25 % duration; discipline substitution | Applied automatically. One line in the morning card. No action required. |
| **L2 — Confirm** | P1 move/drop; adding an unplanned recovery week; threshold zone update > 5 %; week re-plan | One card, two buttons, pre-selected recommendation. Auto-applies in 24 h if ignored. |
| **L3 — Ask** | Race plan change; return-to-train after injury; multi-week restructure | Explicit conversation. Rare by design. |

**Target: ≤ 2 L2 events per month.** Track it as a KPI. If it exceeds that, the plan is mis-specified for the athlete's real life and should be regenerated at lower volume — the engine should say so.

### 6.2 The morning card — the only screen that matters
Opens to exactly this, no scrolling:

```
TODAY · Thursday
Bike — Threshold  ·  1 h 05  ·  06:30, outdoor  ·  12 °C, dry

  3 × 10 min @ 250–262 W, 5 min easy between

WHY  Third and hardest of this block. Everything else
     this week exists to let you hit these 30 minutes.

     Shifted 30 min earlier — rain arrives at 08:00.

[ Start on watch ]     [ Not today ]
```

- One session in focus. Everything else is a tap away.
- `WHY` is always present, always one sentence, always specific to this athlete this week. This is what converts an app into a coach.
- `Not today` is a first-class button, not a failure state. It opens: *reschedule · easier version · shorter version · skip*. All four are safe, and all four feed learning.

### 6.3 Weekly ritual — the only scheduled interaction
Sunday evening, 90 seconds:
- What the week did (one chart: intent delivered vs planned).
- What next week is for (Week Intent, one sentence, the 2–3 P1s named).
- One thing to watch (e.g. *"Your easy runs have crept into Z3 — that's the only thing standing between you and a good Saturday."*).
- Anything the engine needs (travel? pool closed?). At most one question.

### 6.4 Trust rules
- Never change a session inside 4 hours of its scheduled start unless it's a safety issue.
- Never change a session already begun.
- Never surface an adaptation the athlete didn't ask for during their evening wind-down window.
- Never use the word "failed". The athlete missed nothing; the plan adapted.

---

## PART 7 — ENVIRONMENT & LOGISTICS ENGINE

Structurally V1 is good here. Three corrections.

### 7.1 Poll cadence
V1 polls at T−48 h. Forecast skill at 48 h for precipitation timing is poor. Use **T−48 h (provisional, no writes) → T−18 h (planning) → T−3 h (final, may still time-shift within the same day)**. Only the T−18 h pass may move a session to a different day.

### 7.2 Thresholds — safety is a hard rail, comfort is a preference
Split V1's single "breach" concept in two:

**Hard safety vetoes** (not preferences, cannot be overridden by affinity scores):
- Lightning within 15 km, or forecast during session window → all outdoor, no exceptions.
- Ice / freezing rain → no outdoor bike.
- Wind gusts > 55 km/h → no outdoor bike.
- Heat index > 35 °C → no session > 60 min outdoors; > 40 °C → no outdoor session at all.
- Air quality index > 150 → indoor only; > 100 → no intensity outdoors.
- Darkness without lighting profile → no outdoor bike.

**Comfort preferences** (rain tolerance, temperature minimums, wind dislike) → run through the Elo fallback hierarchy.

### 7.3 Indoor conversion factors
V1 uses a flat −15 to −20 %. Make it intent-aware:

| Intent | Indoor duration factor | Note |
|---|---|---|
| `aerobic_base` / `long_endurance` | 0.75 | Indoor Z2 has near-zero coasting; 45 min indoors ≈ 60 min outdoors |
| `threshold` / `vo2max` | 1.00 | Never shorten quality. Indoor is *better* for these — no junctions, no descents |
| `recovery` | 0.80 | |
| `race_pace` | 1.00 | |

Reciprocally, treadmill runs: set 1 % gradient, mechanical coefficient 0.90, and cap continuous treadmill duration at the athlete's demonstrated tolerance (learned, not assumed).

### 7.4 Fallback ordering
Keep V1's structure. Change the default order to **Time-shift → Indoor → Day-swap → Cross-train**, not day-swap first. Rationale: time-shifting preserves the physiological architecture of the week entirely; day-swapping is the most disruptive option and V1 ranks it first. Individual Elo scores then override this default.

---

## PART 8 — PREFERENCE LEARNING

### 8.1 One model: contextual Elo
Ratings live per (option × context bucket), not per option globally.

```
context_bucket = (discipline, intent_class, duration_band, season)
   duration_band ∈ {<45, 45–90, 90–150, >150 min}
   intent_class  ∈ {easy, quality, long}
```
Example: `indoor_bike` may sit at 1350 for (bike, quality, <45) and 900 for (bike, long, >150). V1's single "Indoor_Conversion_Affinity: 0.20" cannot express this, and the difference is exactly what makes a proposal feel smart or stupid.

### 8.2 Signals and weights

| Signal | K-factor | Note |
|---|---|---|
| Onboarding "would you rather" | 16 | 8 pairs max, gamified |
| Accepted proposal | 8 | |
| Rejected + reason chip | 24 | Strongest signal |
| Silently ignored (session skipped) | 12 | Implicit rejection |
| Manual override to a different option | 32 | Strongest of all — revealed preference |
| Completed and rated positively | 12 | |

### 8.3 Reason chips → targeted updates
Critical detail V1 gets right and must be preserved: *a rejection is not a rejection of the option*. Route it:
- "Schedule conflict Sunday" → temporal constraint on Sunday, **no Elo change** for the option.
- "I hate the trainer" → Elo penalty scoped to that context bucket.
- "Too hard today" → readiness signal, no preference signal.
- "Wrong time of day" → time-window constraint.

### 8.4 Cold start
Seed from persona defaults, mark ratings `low_confidence`. While low-confidence, the engine prefers **reversible** options (time-shift over day-swap) and explains slightly more. Confidence rises with sample count; explanation verbosity drops. **The app should get quieter the longer you use it.** That is the measurable expression of "no thinking".

---

## PART 9 — LIFE EVENTS (largely missing from V1)

### 9.1 Taper
Trigger: `weeks_to_A_race ≤ taper_length` (2 weeks for 70.3, 1–2 for Olympic).
- Volume: −40 % week 1, −60 % week 2 (of peak-week volume).
- **Intensity fully retained.** Frequency fully retained. Only duration falls. This is the most-violated taper rule in age-group triathlon.
- Keep short race-pace efforts every 2–3 days to hold neuromuscular sharpness.
- Target race-day TSB: +5 to +25. The engine actively steers toward it and reports the projection daily during taper.
- Suppress all novelty: no new sessions, no new intensities, no equipment changes.

### 9.2 Race week
- Rest day at R−3 or R−2 (learned from the athlete's history if available).
- R−1: 20–30 min easy with 3–4 × 30 s at race pace. Bike safety check. Zero decisions required.
- Race-day briefing generated from the athlete's actual thresholds and the course profile: pacing targets by segment, fuelling rate (g CHO/h), expected splits, contingency for heat.

### 9.3 Post-race
- 70.3: 3 days full rest → 5 days Z1 optional → reassess at day 10. Do not permit intensity until day 12 even if the athlete feels fine; connective-tissue recovery lags perceived recovery.
- Olympic: 2 days rest → 4 days easy → intensity from day 7.
- CTL is expected and allowed to drop. State this explicitly so the athlete doesn't panic at the graph.

### 9.4 Travel
Detected from calendar (multi-day events, location changes).
- Ask **once**, ahead of time: pool? bike/trainer? gym? — and remember the answer per destination.
- Front-load key sessions in the days before departure (never on the travel day).
- Travel days: mobility or nothing. Long-haul: 1 day easy per 2 time zones crossed.
- Prescribe portable sessions (run + bodyweight strength) for the trip; suppress swim-frequency alarms.
- On return: 2 easy days before resuming P1s.
- Never generate a plan requiring equipment the athlete has already said they won't have.

### 9.5 Detraining and return
After ≥ 10 days off:
- Restart CTL at `pre_break_ctl × decay(days_off)` — roughly −1.5 %/day beyond day 7 for aerobic fitness, but **mechanical tolerance decays faster than aerobic fitness**, so reset mechanical caps to 60 % of pre-break and re-ramp at ≤ 8 %/week.
- Explicitly regenerate the macrocycle rather than trying to catch up to the old one.

### 9.6 Heat and altitude
- Heat: if the A-race climate is > 6 °C warmer than home, insert 8–10 heat-acclimation sessions (60–90 min, easy, deliberately over-dressed or indoor unventilated) in the final 3 weeks, replacing P2 volume — never P1 quality.
- Altitude: if racing > 1500 m, flag pacing adjustment (−6 % threshold power per 1000 m above 1000 m) in the race briefing.

---

## PART 10 — MULTI-AGENT ARCHITECTURE, CORRECTED

The TDD's Head Coach → Discipline Agents → Evaluator flow is sound but puts too much physiology inside the LLM. LLMs are excellent at *articulating* and *composing*; they are unreliable at arithmetic and constraint satisfaction.

**Split responsibility:**

| Layer | Implementation | Owns |
|---|---|---|
| State Vector | Deterministic code | All metrics, CTL/ATL, ACWR, thresholds |
| Hard rails H1–H10 & invariants | Deterministic code, unit-tested | Safety. **Never LLM.** |
| Arbiter precedence & change budget | Deterministic code | Conflict resolution |
| Session content generation | LLM (discipline agents) | Interval structure, progression variety, drills |
| `why` and change-log copy | LLM | Voice, explanation, encouragement |
| Weekly narrative & coaching nudges | LLM with RAG over athlete history | Insight |

**Validator gate:** every LLM-produced session is parsed into the Session Object schema and run against the invariant suite before it can be persisted or pushed to Garmin. Failures retry once with the violated constraint injected, then fall back to a deterministic template. **No LLM output ever reaches the athlete's watch unvalidated.**

**Determinism requirement:** given an identical State Vector and identical inputs, the Arbiter must produce an identical decision. Log every decision with its inputs so any change can be explained after the fact, and so the whole system can be regression-tested against replayed seasons.

---

## PART 11 — IMPLEMENTATION ORDER

Sequenced by dependency and by how much "no thinking" each step buys.

| Phase | Build | Unlocks |
|---|---|---|
| **1** | State Vector + Session Object with P1/P2/P3 + intent vocabulary | Everything. Nothing else works without this. |
| **2** | Plan generation (macro/meso/micro) + hard rails H1–H10 + invariant test suite | A plan that is correct before it is adaptive |
| **3** | Execution engine + EQ score + continuous threshold estimation | The app knows how you're actually going |
| **4** | Readiness engine + Arbiter + autonomy ladder + morning card | The "no thinking" experience lands here |
| **5** | Environment engine + contextual Elo | Real-world robustness |
| **6** | Life events (taper, race week, travel, illness) | Full season coverage |

Ship 1–4 before touching 5. V1's document is heavily weighted toward phase 5 work, which is the least valuable until the spine exists.

---

## PART 12 — HOW TO KNOW IT'S WORKING

Not "am I happy and using it" — that's unfalsifiable. Instrument these:

**Coaching quality**
- % of P1 sessions completed with EQ ≥ 0.8 *(target > 85 %)*
- `grey_zone_index` trend *(should fall)*
- Injury/illness days per 12 weeks *(should fall)*
- Threshold estimates trending up across a block *(the actual point of the exercise)*
- Race-day TSB inside the +5 to +25 band

**"No thinking"**
- L2/L3 confirmations per month *(target ≤ 2)*
- Median time in app per day *(target < 90 s — falling is winning)*
- % of days the athlete opens the app and does nothing but start the session *(target > 80 %)*
- Manual override rate *(should fall as Elo confidence rises; if it doesn't, preference learning is broken)*

**Trust**
- Plan reverts per month *(target ~0)*
- % of adaptations accepted *(target > 90 % — low means proposals are bad, not that the athlete is difficult)*

---

## APPENDIX A — V1 → V2 TRACEABILITY

| V1 element | V2 disposition |
|---|---|
| Garmin push/execute/ingest loop | Kept (Part 0 baseline, unchanged) |
| Profile & settings engine | Kept, extended into State Vector (1.1) |
| Daily check-in "Aleas" triggers | Replaced by composite readiness with hysteresis (3.1–3.3) |
| Sleep < 6 h → Z2 | Replaced — brittle single trigger |
| Alcohol rule | Kept, dose-graded (3.3) |
| Soreness → swap discipline | Kept but triaged DOMS vs tendon/bone (3.4) |
| Menstrual phase determinism | Replaced by per-athlete regression (3.5) |
| Execution drift A/B/C | Kept, extended with Execution Quality (4.1–4.3) |
| Rule 1 "Let it go" | Kept and promoted to the default |
| Rule 2 Stimulus integration | Kept, capped at 60 % volume into P2 hosts only |
| Rule 3 Phase/weakness priority | Kept, formalised via P1/P2/P3 + Block Focus |
| **Rule 4 TSS redistribution to weekends** | **Removed — injury risk. Replaced by debt forgiveness (4.4)** |
| Forced FTP/CSS test week 1 | Replaced by continuous estimation (4.5) |
| Weather fallback hierarchy | Kept; reordered, split safety vs comfort, retimed polling (Part 7) |
| Affinity score 0.0–1.0 | Replaced by contextual Elo, reconciling with the TDD (Part 8) |
| Rejection micro-prompt | Kept — one of V1's best ideas (8.3) |
| 48-h density cap | Replaced by neuromuscular/mechanical cost check (2.5) |
| Biomechanical ordering rules | Kept verbatim, made explicit (2.5) |
| Daily TSS ceiling, 6-h separation, brick protection | Kept as invariants (5.4) |
| Sacrificial drop / intensity downgrade / long-run preservation | Kept (5.4) |
| Accept/Reject on every change | **Replaced by the autonomy ladder (6.1) — this was the core product bug** |
| Drag-and-drop impact projection | Kept, made non-blocking (5.3) |
| Master Supervisor + sub-coaches | Kept, with deterministic logic pulled out of the LLM (Part 10) |

---

## APPENDIX B — OPEN QUESTIONS

1. **Swim load** is the weakest measurement in the system (no power, unreliable HR). Proposal: govern swim by *frequency + set compliance* rather than load, and exclude swim from CTL entirely rather than polluting it with a bad estimate. Needs a decision.
2. **Strength training load**: mechanical coefficient of 0.60 for loaded lower-body work is a coach's estimate, not a measured value. Calibrate against your own DOMS and next-day run quality over 8 weeks.
3. **Single-athlete overfit risk**: V1 and this document are both written for one athlete. Every threshold above should be a config value with a persona default, not a constant, or generalising will require a rewrite.
4. **HRV source**: Garmin overnight HRV status is a proprietary index, not raw rMSSD, and its normalisation differs from open protocols. Decide whether to use Garmin's status directly (simpler, less controllable) or raw values (better, needs a morning-measurement habit — which costs "thinking").
5. **Cost control**: full-week LLM regeneration is expensive. Deterministic plan construction with LLM-authored session *content* keeps cost roughly flat regardless of adaptation frequency. Confirm this is the chosen architecture before building.
