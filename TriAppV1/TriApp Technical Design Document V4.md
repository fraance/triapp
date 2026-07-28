# **Technical Design Document: TriApp MVP**

**Document Status:** Proposed / V4  
**Related Document:** TriApp Product Requirements Document (PRD)

**Author:** CTO

## **1\. Introduction & Architecture Overview**

TriApp is a dynamic, AI-driven training platform designed to replace static spreadsheets and fragmented trackers. The core technical challenge is building a Stateful AI Orchestrator that can continuously monitor external data (weather, completed workouts, calendar events) and user inputs (fatigue, daily life events like bad sleep) to autonomously adjust a long-term triathlon training plan.

The system relies on a multi-agent AI architecture ("Sub-coaches"), automated data ingestion pipelines, and a responsive web application dashboard.

## **2\. High-Level System Architecture**

The architecture is broken down into four main tiers:

> * **Client Tier:** A progressive web app (PWA) built with React or Next.js, allowing mobile-responsive access for the "Busy Age-Grouper" on the go.  
> * **API & Application Tier:** A Node.js or Python FastAPI backend. Python is recommended due to its mature ecosystem for LLM orchestration (LangChain, LlamaIndex) and data processing.  
> * **AI Orchestration Tier (The "Coach Engine"):** A multi-agent LLM framework. A "Head Coach" agent routes requests to specific "Swim", "Bike", or "Run" agents, and synthesizes their outputs into a cohesive plan.  
> * **Data Tier:** PostgreSQL for relational data (users, auth, structured workout metadata) and a Vector Database (e.g., Pinecone or Weaviate) to store user context, past performance text, and historical coach instructions for Retrieval-Augmented Generation (RAG).

## **3\. Core Components & Data Flow**

### **3.1 Context & Memory Management**

TriApp will solve the "Context Amnesia" problem using a hybrid context-injection pipeline:

> * **Static Context:** User profile data (age, gender, injury history, gear access) is stored in PostgreSQL and injected as a system prompt template into every LLM call.  
> * **Dynamic Context (RAG):** Uploaded files (text notes, menstrual cycle phase) are embedded into the Vector DB. When the AI generates a plan, it queries the Vector DB for the user's historical performance in similar scenarios.

### **3.2 Dynamic Re-evaluation Engine (The Adaptation Loop)**

The system must not treat the training schedule as a list of isolated tasks, but as a connected ecosystem. It must look at the whole week/month and shuffle the puzzle pieces to keep the user happy, consistent, and on track. We will implement an Event-Driven architecture using a message broker (e.g., Redis Pub/Sub or AWS EventBridge) to trigger plan re-evaluations.

**The Elo-Driven User Preference Matrix:** Instead of hardcoded rules or static surveys, the Adaptation Engine relies on a Pairwise Comparison algorithm (Elo Rating System). During onboarding (and via continuous feedback loops), users are presented with gamified "Would You Rather" trade-off scenarios (e.g., "Indoor Bike vs. Run in Rain"). The backend calculates and assigns an Elo score to each fallback option. The AI then dynamically injects the highest-scoring options when an adaptation trigger occurs.

| Trigger Event | Data Source | Dynamic System Action   |
| :---- | :---- | :---- |
| **Weather Change (e.g., Rain predicted)** | OpenWeather API (Daily cron job) | **Action:** Trigger AI to reshape the microcycle. AI queries the user's Elo scores for weather fallbacks. It will execute the option with the highest score (e.g., swap\_day: 1250, indoor\_trainer: 1100, run\_in\_rain: 950). |
| **Lifestyle (Fatigue, bad sleep, wine)** | Web App Dashboard | **Action:** Trigger AI to reduce intensity (TSS) for the next 24-48 hours. The AI queries the fatigue Elo scores to decide whether to prioritize active recovery (stretching/renfos) or total rest. |
| **Workout Completed (Harder than planned)** | Garmin Webhook | **Action:** Calculate TSS delta. If delta \> threshold, trigger AI to adjust next sessions by looking at the remaining weekly TSS budget and shaving intensity proportionally to avoid overreaching. |
| **Calendar Event (e.g., Travel, Vacation)** | Google/Apple Calendar API (Two-Way Sync) | **Action:** AI continuously scans for multi-day events or blocked time. If context is missing, it proactively asks the user (e.g., "Will you have access to a pool/bike on your trip to London?"). It then **holistically** restructures the macrocycle (e.g., front-loading volume before the trip, scheduling portable run/strength workouts during travel, and planning a recovery phase upon return). |

## **4\. Data Schema & Models (High Level)**

We will use a relational database structure to track the core entities.

**Table: Users**

> * id (UUID)  
> * oauth\_garmin\_token (String)  
> * calendar\_sync\_url (String)  
> * profile\_data (JSONB) → *Updated: Instead of static hierarchy arrays, this field will now store dynamic preference\_elo\_scores (e.g., { "indoor\_bike": 1200, "run\_in\_rain": 950, "active\_recovery": 1150 }) calculated by the backend Pairwise Comparison engine.*

**Table: Training\_Plans**

> * id (UUID)  
> * user\_id (UUID, FK)  
> * target\_race\_date (Date)  
> * current\_phase (String) // e.g., Base, Build, Taper

**Table: Planned\_Sessions**

> * id (UUID)  
> * plan\_id (UUID, FK)  
> * discipline (Enum: Swim, Bike, Run, Strength)  
> * scheduled\_date (DateTime)  
> * ai\_instructions (Text)  
> * target\_tss (Float)  
> * status (Enum: Planned, Completed, Skipped, Adapted)

## **5\. External Integrations & APIs**

> * **Garmin Health API / Connect API: (Two-Way Sync)** Used to pull raw FIT files and daily health metrics (Sleep score, HRV). We will register a webhook so Garmin pushes data to our servers immediately upon workout completion, rather than polling.  
> * **Calendar Integration (Two-Way Sync):** Instead of just outputting an .ics feed, the system must authenticate (via Google Calendar or Apple Calendar API) to **read** the user's schedule continuously. The system scans for upcoming travel, all-day work events, or vacations to feed into the adaptation engine, prompting the user for missing info when necessary.  
> * **Weather API:** Integration with a service like OpenWeatherMap or Tomorrow.io. A background job will check the forecast for the user's geolocated ZIP code every 12 hours against their planned outdoor sessions.

## **6\. AI "Sub-Coach" Multi-Agent Architecture**

Instead of passing the entire prompt to a single model, we will use a Multi-Agent system to ensure discipline-specific accuracy:

> 1. **The Planner Agent (Head Coach):** Reviews total weekly load and distributes TSS across disciplines. *Also responsible for detecting missing context from upcoming calendar events and proactively querying the user.*  
> 2. **The Discipline Agents (Swim, Bike, Run):** Receive daily TSS targets from the Head Coach. They generate the specific, detailed session intervals (e.g., "10x 100m at Threshold pace").  
> 3. **The Evaluator Agent:** Reviews the final combined schedule to ensure rules aren't broken (e.g., no heavy leg day before a long run).

## **7\. Security, Privacy & Compliance**

> * **OAuth Management:** Garmin access tokens must be encrypted at rest in the database. *(Note: Strava integration removed based on previous cleanup).*  
> * **Data Anonymization:** When passing user performance context to the LLM API (e.g., OpenAI), all Personally Identifiable Information (PII) like exact names or sensitive locations will be masked.  
> * **Rate Limiting:** Implement strict rate limiting on the AI generation endpoints to prevent runaway costs from continuous schedule regenerations. Allow maximum 3 manual regenerations per day, plus automated background re-evaluations.