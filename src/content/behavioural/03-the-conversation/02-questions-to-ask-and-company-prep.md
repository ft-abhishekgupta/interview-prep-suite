---
title: Questions to Ask and Company Prep
description: A categorised bank of questions to ask interviewers and a practical checklist for researching a company before onsite interviews
difficulty: Foundational
tags: [questions-to-ask, company-research, interview-prep, behavioural]
---

The questions you ask at the end of every interview are not a courtesy slot — they are actively evaluated, and they are also your best tool for finding out whether the role is actually right for you. Treating this as an afterthought wastes one of the highest-leverage parts of the entire loop.

## Why your questions are part of the evaluation

Interviewers form an impression from the questions you ask: specific, well-researched questions signal genuine interest and preparation, while "no, I think you've covered everything" signals low investment, even if unintentional. Good questions also let you tailor follow-up conversations — asking a manager about team structure gets a different, more useful answer than asking an IC the same question, so matching your question to the interviewer's role gets you better signal as well as better optics.

> [!KEY]
> Prepare more questions than you'll use, tailored per interviewer, and let earlier answers in the loop retire questions that get answered naturally — asking something you were already told is a bigger miss than asking too few questions.

## A categorised question bank

### Team and role

| Question | What it signals about you | What the answer signals about them |
|---|---|---|
| "What does the team's on-call rotation actually look like week to week?" | You think about sustainability, not just the job title | Whether on-call load is reasonable or a hidden burden |
| "How is work typically divided across the team?" | You're thinking about fit and autonomy | Whether roles are well-defined or chaotic |
| "What would success look like in this role after six months?" | You think in outcomes, not just tasks | Whether expectations are concrete or vague |

### Technical and architecture

| Question | What it signals about you | What the answer signals about them |
|---|---|---|
| "What's the biggest architectural constraint the team is working around right now?" | Genuine technical curiosity and depth | Honesty about technical debt versus a sales pitch |
| "How do you decide when to pay down technical debt versus ship features?" | You understand the real trade-off senior engineers navigate | Whether debt is actively managed or perpetually deferred |
| "What does your deployment and rollback process look like?" | Operational maturity | Actual engineering rigor versus stated rigor |

### Process and delivery

| Question | What it signals about you | What the answer signals about them |
|---|---|---|
| "How does the team handle scope changes mid-sprint?" | You've dealt with this reality before | Whether planning is respected or constantly overridden |
| "How are incidents reviewed, and what happens after a postmortem?" | You care about durable fixes, not just fire-fighting | Blameless culture versus blame culture |
| "How much of the roadmap is typically set quarter to quarter versus decided reactively?" | Interest in planning stability | Whether the team has real strategic space or is purely reactive |

### Culture and growth

| Question | What it signals about you | What the answer signals about them |
|---|---|---|
| "How do people typically grow from this level to the next here?" | Ambition paired with realism | Whether growth paths are clear or improvised |
| "Can you tell me about a recent instance of someone disagreeing with a decision and it changing the outcome?" | You value substance over politeness | Whether dissent is genuinely welcomed |
| "What's something the team has changed about how it works in the last year?" | Interest in continuous improvement | Whether the team adapts or is stagnant |

### Manager and expectations

| Question | What it signals about you | What the answer signals about them |
|---|---|---|
| "How do you like to give and receive feedback?" | Self-awareness about working styles | Their actual management style, not just stated values |
| "What's the biggest challenge the last person in this role faced?" | You're thinking realistically about the job | Honesty about the role's hard edges |
| "How involved are you day to day versus how much autonomy does the team have?" | Interest in fit, not just approval | Management style — hands-on or hands-off |

### Business and strategy

| Question | What it signals about you | What the answer signals about them |
|---|---|---|
| "How does this team's work connect to the company's broader priorities this year?" | Strategic thinking beyond your own tasks | Whether the interviewer can articulate it clearly |
| "What's the biggest competitive or market risk the company is watching right now?" | Business literacy, not just technical focus | How grounded leadership's thinking is |
| "How has the team's headcount or scope changed in the last year?" | Practical interest in stability | Growth trajectory versus contraction, indirectly |

## Questions that are red flags to ask

Some questions technically fine to ask can land poorly depending on timing and framing — avoid leading with these, even if you genuinely want the answer:

- "What's your attrition rate?" asked bluntly and early — reframe as "how long do people typically stay on the team, and why do people leave?"
- "Is there a lot of overtime expected?" asked without context — reframe as "how does the team handle crunch periods around major launches?"
- Purely compensation-focused questions in a technical round — save these for the recruiter or hiring manager conversation.
- "Why did the last person leave this role?" asked confrontationally — reframe as "what's changed about this role since it was last filled?"

## Probing on-call, tech debt, and reorg risk politely

These are legitimate, important things to understand before joining, but blunt phrasing can read as adversarial. Frame them as forward-looking and collaborative rather than as an audit:

```mermaid
flowchart LR
    A["Blunt - is on-call brutal here"] --> B["Reframed - what does a<br/>typical on-call week look like"]
    C["Blunt - how much<br/>tech debt do you have"] --> D["Reframed - what's the biggest<br/>constraint you're working around"]
    E["Blunt - are there<br/>layoffs coming"] --> F["Reframed - how has team<br/>scope changed in the last year"]
```

> [!TIP]
> The reframed versions get you the same underlying information — you can infer attrition, debt severity, and stability risk from the honesty and specificity of the answer — without putting the interviewer on the defensive.

## Tailoring questions to the interviewer's role

Ask an IC about day-to-day reality (code review culture, how decisions actually get made, what surprised them after joining). Ask a manager or hiring manager about team structure, growth paths, and expectations. Ask a skip-level or director about strategy, how the team's success is measured at the org level, and where the team fits into a multi-year plan. Asking a director a question best suited for an IC ("what's it like day to day") wastes a rare opportunity to get strategic context you can't get elsewhere in the loop.

> [!WARNING]
> Do not ask the exact same generic question of every interviewer — it's the fastest way to look like you're running through a rehearsed script rather than genuinely curious about each person's perspective.

## Company preparation: what to research

Before onsite interviews, spend focused time on a small set of high-value research areas rather than broad, shallow browsing:

| Area | What to look for | Where to find it |
|---|---|---|
| Product and business model | How the company actually makes money, who the core customer is | Company site, recent earnings calls or press if public |
| Customers and competitors | Who they serve, who they compete with, and how they differentiate | Industry press, comparison articles |
| Recent launches | What shipped in the last 6–12 months | Product blog, changelog, release notes |
| Engineering blog | Architecture choices, scale numbers, technical culture signals | The company's own engineering blog |
| Tech stack | Languages, frameworks, cloud provider, notable open-source projects | Engineering blog, job postings, public repositories |
| Recent news | Funding, leadership changes, layoffs, major incidents | General search, recent news coverage |

## Mapping your experience to the job description

A focused half-hour exercise: list every bullet point from the job description in one column, and your closest matching experience in the second. Gaps identified this way are exactly the moments to prepare a bridging answer, rather than being surprised by them live.

| Job description requirement | Your matching experience |
|---|---|
| "Leads technical direction across multiple teams" | Led the queue migration affecting three consuming teams |
| "Mentors and grows junior engineers" | Structured mentoring of a junior engineer through on-call ownership |
| "Comfortable operating with ambiguity" | Drove the internal tooling initiative with no formal specification |
| "Experience with high-availability, high-scale systems" | Owned a service with a 99.99% availability target under thousands of requests per second |

## Preparing for the specific interview format

Formats vary enough that generic prep is not sufficient. Ask the recruiter directly, ahead of time, how many rounds there are, what each round covers (system design, coding, behavioural, hiring manager), and roughly how long each lasts — this single conversation often removes most of the uncertainty candidates otherwise waste energy on. If a round is unusually structured (a take-home, a pairing exercise, a presentation), ask for a specific example or rubric if one is offered.

## A one-hour prep checklist

- 15 minutes: read the company's engineering blog for the two most recent relevant posts.
- 10 minutes: skim recent product launches or news from the last quarter.
- 10 minutes: map the job description against your experience, two-column exercise.
- 10 minutes: prepare 2–3 tailored questions per expected interviewer type (IC, manager, director).
- 10 minutes: review your story bank's coverage matrix and note which stories fit this specific role's emphasis.
- 5 minutes: confirm logistics — format, duration, and who you're meeting, from the recruiter.

## Cheat sheet

- Questions you ask are actively evaluated — prepare specific ones, not generic ones.
- Tailor questions to the interviewer's role: IC for day-to-day reality, manager for team structure, director for strategy.
- Reframe blunt questions (attrition, tech debt, layoffs) as forward-looking, collaborative versions.
- Avoid pure compensation questions in technical rounds; save those for the recruiter or hiring manager.
- Research product, customers, recent launches, engineering blog, and tech stack before onsite.
- Map the job description against your experience in a two-column exercise to find and prepare for gaps.
- Confirm interview format and duration directly with the recruiter ahead of time.

## Common mistakes

| Mistake | Fix |
|---|---|
| Asking the same generic question of every interviewer | Tailor at least one question per interviewer's role |
| "No, I think you've covered everything" | Always have at least two prepared questions ready |
| Blunt phrasing on attrition, debt, or layoffs | Reframe as forward-looking, collaborative questions |
| Leading with compensation questions in a technical round | Save those for the recruiter or hiring manager conversation |
| Shallow, broad research across too many areas | Focus on product, recent launches, and the engineering blog |
| No mapping between job description and your experience | Do the two-column exercise before the interview |

## Summary

The questions you ask are an active, evaluated part of the interview, not a courtesy, and they double as your own diligence tool for whether the role is genuinely a good fit. Build a categorised bank tailored to each interviewer's role, reframe sensitive questions like attrition or tech debt collaboratively rather than bluntly, and spend a focused hour before onsite interviews researching the product, recent launches, and engineering blog, and mapping your experience against the job description. This preparation is cheap relative to the loop itself and consistently changes how prepared and genuinely engaged you appear.

## Top Interview Questions

### Q1. What questions do you typically ask at the end of an interview, and why?

I tailor questions to the interviewer's role rather than asking the same thing of everyone. With an IC, I might ask what surprised them most after joining, since that reveals gaps between the pitch and the reality. With a manager, I ask how the team handles scope changes mid-sprint, since that reveals whether planning is respected in practice. With a more senior leader, I ask how the team's work connects to broader company priorities. I keep a few in reserve and drop ones that get answered naturally earlier in the conversation, since re-asking something already covered wastes the opportunity.

### Q2. How would you politely find out about on-call burden without asking directly if it's bad?

I'd ask something like "what does a typical on-call week look like for the team, and how often does something actually page someone overnight?" rather than bluntly asking if it's brutal. This gets at the same information — frequency, severity, and whether it's sustainable — without putting the interviewer on the defensive, and the specificity or vagueness of their answer usually tells me what I need to know. If the answer is vague or deflects the numbers, that itself is informative.

### Q3. How do you research a company before an onsite loop?

I focus on a small set of high-value areas rather than broad browsing: the two or three most recent posts on their engineering blog for technical culture and scale signals, recent product launches or news from the last quarter for business context, and the general shape of their tech stack from job postings or public repositories. I specifically avoid spending time on generic "About Us" content that doesn't help me ask better questions or connect my experience to their actual problems.

### Q4. How do you decide which questions to ask an IC versus a hiring manager versus a director?

I match the question to what each person actually has good visibility into. An IC can tell me about day-to-day reality — code review norms, how decisions actually get made versus how they're supposed to be made, what they'd change if they could. A hiring manager can speak to team structure, growth paths, and expectations for the role. A director or skip-level can speak to strategy and how the team's success is measured at an organisational level. Asking a director what a typical day looks like wastes a rare chance to get context I can't get from anyone else in the loop.

### Q5. Tell me about a time researching a company changed how you approached an interview.

Before one onsite, I read the company's engineering blog and found a post about a significant scaling challenge they'd faced with a pattern very similar to a project I'd led. I brought that specific connection up naturally when discussing my background, rather than describing my experience generically, and it led to a much deeper technical conversation than a first-pass answer would have. It also gave me a genuinely well-informed question to ask about how their approach had evolved since that post, which the interviewer clearly appreciated as a sign of real preparation.

### Q6. How would you find out about a team's technical debt situation without seeming like you're digging for problems?

I'd ask something like "what's the biggest architectural constraint the team is currently working around?" which invites an honest, specific answer rather than a binary "yes we have debt" or defensive denial. Most engineers are happy to talk candidly about a real constraint when asked this way, since it's framed as understanding the technical landscape rather than as an audit. The specificity and candour of the answer also tells me a lot about the team's culture around acknowledging debt versus glossing over it.

### Q7. How do you approach mapping your experience to a job description before an interview?

I do a simple two-column exercise: every requirement or responsibility from the job description in one column, and my closest matching experience in the other. This surfaces both strong matches I should lead with and genuine gaps I should prepare a bridging answer for, rather than being caught off guard live. For example, if a posting emphasises mentoring junior engineers and I have a strong example, I make sure that story is primed and ready; if it emphasises a technology I have limited exposure to, I prepare an honest answer about my closest adjacent experience and my plan to ramp up.

### Q8. What's a red flag question that candidates sometimes ask, and how would you ask it better?

Bluntly asking "why did the last person in this role leave?" can come across as confrontational and puts the interviewer in an awkward position, especially if the departure was difficult. I'd reframe it as "what's changed about this role or team since it was last filled?" which gets at similar information — whether the role's scope or expectations have shifted, which can indirectly reveal why someone left — without asking the interviewer to speak negatively about a specific person or situation.

### Q9. How do you decide how much time to spend on company research versus other interview prep?

I treat it as a fixed, time-boxed portion of my overall prep rather than something open-ended, roughly an hour focused specifically on the engineering blog, recent launches, and mapping my experience against the job description. I prioritise this over broader, unfocused browsing, since a specific, well-informed question or connection in the interview is worth far more than generic familiarity with the company's public image. Technical and behavioural prep still gets the majority of my time, since those are what's actually being scored most heavily.

### Q10. Tell me about a question you asked in an interview that gave you genuinely useful signal about whether to join.

I asked a hiring manager, "can you tell me about a recent time someone disagreed with a decision and it actually changed the outcome?" Their answer described a specific, recent example in detail, including what changed and why, which gave me real confidence that dissent was genuinely welcomed rather than just stated as a value. In a different interview, the same question got a vague, generic answer about "we value all opinions," which was a much weaker signal and something I weighed when comparing offers.

### Q11. How do you prepare for an unfamiliar interview format, like a take-home assignment or a presentation round?

I ask the recruiter directly, ahead of time, exactly what to expect — how the round is evaluated, roughly how long it should take, and whether there's a rubric or example available. For a presentation round specifically, I'd also ask who the audience is and what level of technical depth is appropriate, since presenting to a mixed technical and business audience requires a different structure than presenting to an all-engineering panel. Getting this logistical clarity upfront removes a lot of wasted uncertainty that would otherwise eat into actual preparation time.

### Q12. Why do you think the questions a candidate asks are evaluated, and what does a strong one look like to you?

The questions reveal how much genuine thought a candidate has put into whether this specific role and team are right for them, which is different from how well they perform on a scripted technical or behavioural question. A strong question is specific to something I've actually researched or heard earlier in the loop — for example, referencing a technical trade-off mentioned by an earlier interviewer and asking how the team is thinking about it going forward — rather than a generic question that could apply to any company. That specificity signals both preparation and real engagement, which is exactly what I'd want to see if I were on the other side of the table.
