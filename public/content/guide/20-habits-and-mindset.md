# Habits, Consistency & Mindset

> [!NOTE]
> **In short**
> - Results come from showing up for years, not from a perfect plan. We design for that on purpose.
> - Anchor training to your morning routine, decide in advance when, where and what you'll do, and set up your surroundings so starting is easy.
> - Keep a minimum viable session for bad days, and live by one rule: never miss twice.
> - You know how to train; the arm sets the pace. Comparing yourself with your pre-injury numbers is the comeback trap. That, fear and frustration are all normal, and there's a tool for each.
> - Training should lower your stress, not add to it. Follow the readiness rule, review your week, and get support early.

## Why habits beat motivation

Motivation is a feeling, and it comes and goes. A habit is a behaviour that a cue triggers almost automatically. You want training to become a habit, so it happens on the mornings motivation doesn't turn up.

- **How long it takes.** A UCL study by Lally and colleagues followed 96 people for 12 weeks as each built one new habit. Behaviours took about 66 days to feel automatic, with a range of 18 to 254 days. A 2024 review found medians of 59–66 days and individual times from 4 to 335 days, and morning habits tended to be stronger. **[Moderate evidence]** If you trained regularly for years before the injury, an old routine usually comes back faster than a new one is built. **[Expert opinion]** The new parts still need their couple of months: perhaps an earlier start, a new gym routine, and doing everything one-handed.
- **Missing a day isn't fatal.** In the UCL study, missing a single chance to do the behaviour "did not materially affect the habit formation process." **[Moderate evidence]**
- **The right kind of motivation lasts.** A systematic review of 66 studies found that "autonomous" motivation (doing something because you value or enjoy it) was consistently linked with exercising more, and enjoyment predicted long-term adherence best. **[Moderate evidence]** Guilt and pressure are poor fuel.

So we do two things: build the routine until it runs itself, and find the parts of training you genuinely enjoy.

## Design your morning habit

### 1. Anchor it to what you already do

Habit coaches such as BJ Fogg, creator of the Tiny Habits method, recommend attaching new behaviours to routines you already have, and starting small. **[Expert opinion]** Build a chain where each step triggers the next:

1. Alarm at the same time every training day (05:15 for a 06:00 session).
2. Lie still, take your 60-second pulse, then drink a glass of water and do the check-in (about 2 minutes): on your computer, or on your phone once phone access is set up (below). If neither is possible, jot the numbers in your phone notes, apply the readiness rule from [chapter 17](17-sleep-and-recovery.md) yourself, and enter them when you're back.
3. Pre-gym snack, and put on the kit you laid out last night.
4. Out of the door at a fixed time, with this week's printed sheet in your bag, or your phone if you log on it.
5. At the gym: the warm-up (5 minutes on the bike, then the mobility routine).
6. The session, logged as you go on your phone, or written on the sheet.
7. Breakfast and vitamin D (plus creatine if you take it), then daylight on the way to work or at lunch. If you used the sheet, type it in with **Log a session → Enter from sheet** that evening at the latest.

### 2. Decide when, where and what

An *implementation intention* is a plan in the form "I will [behaviour] at [time] in [place]." In one trial of 248 people, adding a written when-and-where plan had "a dramatic effect" on exercise, where motivational information alone did not. A 2018 meta-analysis found these plans modestly increased physical activity, and a 2025 trial found that adding mental rehearsal strengthened exercise habits. **[Moderate evidence]**

Write yours, plus "if–then" plans for your most likely obstacles. For example:

- **When and where:** "I will do my planned session at 06:00 at my gym, Monday to Saturday."
- "If I wake up late, then I will do my minimum session (**Short on time?** on Today)."
- "If it is icy, wet or dark outside, then I will do my long walk on the treadmill."
- "If the hub says AMBER, then I will halve the sets, keep the same loads, do Zone 2 only and skip intervals."
- "If I tick an arm red flag, or my arm pain is 7/10 or more, then I won't train at all today, physio exercises included, and I'll contact my fracture clinic today (or NHS 111 / 999 as the red-flag guidance says)."
- "If the leg press is taken, then I will swap the order within the session."
- "If I feel strong enough to add a set or jump two load steps, then I'll write it down as next session's plan instead."

The readiness rule behind the AMBER and RED lines is in [chapter 17](17-sleep-and-recovery.md). Spend a minute picturing the routine the night before: the alarm, the bag, the walk in, the first exercise.

### 3. Shape your surroundings

Make the right thing the easy thing. **[Expert opinion]**

- **The night before:** lay out your kit, pack the gym bag with this week's printed sheet, fill the bottle, charge your phone and heart-rate strap, and get the pre-gym snack ready.
- **Bedroom:** alarm across the room, phone charging outside it, the same bedtime every night.
- **Where the hub lives.** It runs on your own computer (`start_hub.bat` or `start_hub.sh`), or on a home server you reach through an SSH tunnel if you set one up (the README and the hosting guide in `deploy/` explain how); either way it stays private to you. Keep it one click away. At the gym you have two ways to log:
  - **The printed sheet (works now).** Print the week on Sunday (**Programme → Print this week**), write your sets on it, and type them in afterwards with **Log a session → Enter from sheet**.
  - **Your phone (optional, home server only).** If you choose, phone access over Tailscale can be switched on (the Tailscale section of the hosting guide in `deploy/`). You then open the hub at your `https://<machine>.<tailnet>.ts.net` address and log as you go. Only the Tailscale logins you list can open it, so keep a screen lock on the phone, and if you lose it, remove it from your Tailscale admin console straight away.
- **One-handed routines:** practise getting ready with your uninjured hand (zips, bottle, locker, shoes). Nothing should need the injured arm. The gym bag follows the carrying rule in [chapter 18](18-arm-recovery.md): 3 kg or less, on your **uninjured** shoulder, put on and taken off with your uninjured hand.
- **Make it pleasant:** podcasts or a playlist for Zone 2 sessions ([chapter 21](21-library.md)), a coffee you enjoy afterwards, or a walking route you like.

### 4. Your minimum viable session

The minimum viable session (MVS) is the smallest session that still counts: your answer to "I can't be bothered" and "I've only got half an hour."

- **The MVS, about 25–30 minutes:** 5 minutes easy on the upright bike, the 10-minute mobility routine, then 10–15 minutes of Zone 2 on the incline treadmill or stair climber, following the arm-safety notes in the exercise library.
- **The floor, for your worst day:** the 10-minute mobility routine at home, using a sturdy chair or worktop for your uninjured hand, plus a 20-minute walk on a safe path.

In the hub, **Short on time?** (on Today and Log a session) loads its version of the minimum session, and **Gym closed?** a bodyweight session for travel. Logging either counts as a session done, though not as the planned strength session. On an AMBER day, the MVS fits comfortably inside "easy day: halve the sets, Zone 2 only, no intervals, hold loads."

### 5. Never miss twice

James Clear's rule is to "avoid making a mistake twice in a row", because "consistency does not require perfection." **[Expert opinion]** Your version: you can miss a day, but you never miss two planned sessions in a row. On the second day, do at least the MVS.

**Don't double up to catch up.** Follow the missed-session rules in [chapter 04](04-the-program.md).

### The scale-down ladder

| Today | What you do |
|---|---|
| GREEN, normal time | The full session |
| GREEN, short of time | Main block plus mobility, about 40 minutes |
| AMBER | Easy day: halve the sets, Zone 2 only, no intervals, same loads |
| Very low day (not RED) | The minimum viable session |
| Worst day | The 10-minute mobility routine plus a 20-minute walk |
| RED | No training today, including your physio exercises, until you've been advised. Contact your fracture clinic today, or NHS 111 / 999 as the red-flag guidance says |

## Identity: becoming someone who trains

James Clear describes three layers of change: outcomes (what you get), processes (what you do) and identity (what you believe about yourself). Habits last when they start from identity: decide the type of person you want to be, then prove it to yourself with small wins. **[Expert opinion]**

- **Write two or three identity statements:** "I train in the mornings." "I'm a hiker in training." "I look after my body, arm included."
- **Keep your lifter identity, and make it injury-proof.** Years of training are an asset: you already know how to show up. But "I'm a lifter" judged by your bench press breaks while your arm heals. "I'm a lifter, and right now that means legs, engine and core, at the pace my arm allows" doesn't.
- **Every logged session is evidence.** Look at your hub history when you doubt yourself.

## Tracking and your weekly review

Tracking works best when you *use* the data. A meta-regression of 122 interventions found that self-monitoring explained more of the differences between programmes than any other technique, especially combined with goal setting or feedback. **[Strong evidence]**

Every Sunday (your rest day), open **Weekly review** and answer briefly:

```
Week of __ (programme week __)
Wins: __ of __ sessions done. Protein target hit on __ days. 7.5 h+ in bed on __ nights.
Struggles: __
Next focus: one change only, e.g. bag packed every night.
Adherence: __%
```

- **Adherence %** is sessions done divided by sessions planned. Count a minimum session as done: showing up is the habit. Over a month, aim for 80% or more. **[Expert opinion]**
- **Don't over-track.** If tracking makes you anxious, cut back to the check-in and the session log. Data serves decisions, not the other way round.

## Motivation and discipline

Pat McNamara says that when motivation runs out, you rely on discipline, and Jocko Willink's book title puts it as *Discipline Equals Freedom*. Discipline works best as a system rather than willpower: the anchor, the plan, your surroundings and the MVS do the heavy lifting, so you don't have to win an argument with yourself first thing in the morning. **[Expert opinion]**

Enjoyment and personal meaning still predict sticking with exercise long-term. **[Moderate evidence]** Grow yours: chase goals that excite you (your first big walk in the hills, your first farmer carry since the injury), write one thing you enjoyed in each weekly review, vary your walking routes, learn hill skills, and train with people you like.

## Setbacks: illness, travel, holidays and fasting

- **Illness:** symptoms only above the neck mean an easy Zone 2 walk at most. Fever, chest symptoms, body aches or a stomach bug mean rest, then restart 24–48 hours after symptoms clear with a deload-style week. **After a fracture, a fever or feeling unwell is also an arm red flag:** tick it, and contact the fracture clinic / NHS 111.
- **Travel or a closed gym:** use **Gym closed?** in the hub, or walk (steps count), then 20–30 minutes of bodyweight split squats with your uninjured hand on a wall, step-ups on a stair with the rail on your uninjured side, wall sits, glute bridges and dead bugs on the bed, and single-leg balance next to a support. Get onto and off the bed by rolling onto your uninjured side, never leaning on the injured arm.
- **Public holidays and festivals** will land somewhere in your programme. Look a month ahead: gym opening hours, travel days and which days you'll train.
- **Fasting periods** (for example Ramadan, another religious fast or planned fasting): if you fast, your routine shifts for the period. Add the dates under **Settings → Fasting periods** and the hub runs easy days automatically. Train after you break your fast if you can ([chapter 14](14-nutrition.md)), and write the new anchor chain a week or two before it starts.
- **Busy weeks:** protect sleep first, then the strength sessions, then cardio (the short version or the MVS).

## Patience while your arm heals

### What's normal to feel

Fear of re-injury (knocks, falls, the first time you grip something), frustration that you "can't train properly", comparison with other people or your old self, impatience to rush the next gate, and low mood. All normal.

### What the evidence says

A review of 77 studies of sport-related knee injuries found that psychological factors such as fear, confidence and expectations influence every stage of recovery, and in one cohort of footballers who didn't return after knee ligament surgery, about half named fear of re-injury as the reason. **[Moderate evidence]** Your injury is different, but the lesson carries over: the head heals as well as the body.

### Tools that help

1. **Clarity beats worry.** Ask the clinic exactly what you can and can't do, get it in writing, and record it in the hub.
2. **Your gates are small, supervised steps.** When a gate opens, keep the first two weeks at the new level deliberately easy. **[Expert opinion]**
3. **Control the controllables:** legs, engine, core, sleep and food. These matter most for hiking anyway.
4. **Make progress visible** on **Your arm** in the hub, and watch the trend, not the day.
5. **Train the good arm once allowed.** In a trial of women over 50 with a wrist fracture, training the uninjured hand led to better grip in the fractured hand at 12 weeks (17.3 kg against 11.8 kg). A Cochrane overview rates this evidence as low certainty, and the fracture differs from yours. **[Moderate evidence]** Treat it as promising, not proven, and start only after Good arm OK.
6. **Compare you with you a month ago,** using your 4-week tests, not with you before the injury, and mute accounts that make you feel behind.
7. **Tell your physio about fear.** Fear of movement is something physios deal with routinely. **[Expert opinion]**

### Ego on the way back

As an experienced lifter, your biggest risk isn't technique. It's the numbers in your head. **[Expert opinion]**

- **Your old bests are history, not this month's target.** Write them down once, then judge every session against your hub logbook instead.
- **Let the loads come back through double progression.** It finds your level within a couple of sessions and keeps climbing from there. There's no 1RM testing: the hub estimates it from normal sets.
- **Know the comeback traps:** adding sets because you feel fine, jumping two load steps at once, skipping a deload, training through AMBER, and grading a session against your pre-injury log.
- **New gate, familiar movement, healing tissue.** When a gate opens, keep the first two weeks at the new level easy, even if the movement feels second nature. Your muscles remember it; the healing bone and the tissue around it are starting again.
- **You know how to train; the arm sets the pace.** Your legs, engine and core can work as hard as the plan says. The arm decides everything else.

> [!SAFETY]
> Know the difference between fear and danger. The red flags in [chapter 18](18-arm-recovery.md) are danger: stop and call. The pain rules are in [chapter 19](19-injury-prevention.md). If you're unsure, stop and ask.

## Exercise and your mental health

- **Exercise works for depression.** A 2024 BMJ network meta-analysis of 218 trials found walking or jogging, yoga and strength training among the most effective forms, with bigger benefits at higher intensities, though the certainty of evidence was low. **[Moderate evidence]**
- **It helps anxiety and distress too.** A 2023 overview of 97 reviews found medium-sized benefits for depression, anxiety and distress. **[Strong evidence]**

Every Zone 2 walk and strength session is mental-health training too. Log your mood in the check-in and watch the trend.

> [!WARNING]
> Exercise doesn't replace care. If low mood or anxiety hangs around for weeks, or starts affecting daily life, speak to your GP. In England you can refer yourself to NHS Talking Therapies (you must be 18 or over, or 16 in some areas, and registered with a GP). If you're in crisis or thinking about harming yourself, call 999, or call Samaritans free on 116 123, 24 hours a day.

## Burnout-aware training

Training is a stressor, and your body adds it to work, money and poor sleep. A sports-science consensus statement stresses balancing stress and recovery, including "other life demands". **[Expert opinion]** In a review of 55 studies, about 76% found psychological stress predicted less physical activity, and in another study higher chronic stress slowed recovery of strength after a hard session. **[Moderate evidence]**

High stress isn't an automatic AMBER in the hub, but you're always allowed to choose the AMBER version on a high-stress day. Choosing an easy day is a skill, not a weakness. **[Expert opinion]**

**Signs you're overdoing it** **[Expert opinion]**: several AMBER days in a week, resting HR creeping up over a fortnight, dreading sessions, irritability, poor sleep, performance dropping despite effort, or frequent colds. If you notice two or more, take your next deload early (the hub suggests it but won't do it for you; [chapter 17](17-sleep-and-recovery.md) shows how) and raise it in your weekly review. Don't add bonus sessions: 45–90 minutes, six days a week, is already plenty when you're coming back from a layoff, and extra work doesn't bring the gates closer.

## Social support

Support specific to exercise, such as someone who walks with you or gets you to the gym, is linked with being more active. **[Moderate evidence]** Goals shared publicly work particularly well. **[Strong evidence]**

1. **Tell one or two people your 12-week goals.**
2. **Find a walking partner** for the Saturday long walk. Company makes long Zone 2 easier, and it's safer while a fall is your biggest risk.
3. **Use the gym staff** for anything that needs two hands or more than your uninjured hand should take: loading leg-press plates heavier than 10 kg and setting the safety catches, for example.
4. **Join a walking group later.** Many areas have Ramblers groups and other walking clubs, often with walks graded from easy to strenuous (not verified for your area). Check how first walks work, and stick to easy, good-path walks until your gates allow more.
5. **Treat your clinic and physio as part of your team.** Show them your training log.
6. **Ask for practical help** with shopping, jars and heavy doors. Every task you don't force through the injured arm protects it.

## Your actions this week

- [ ] Set **one alarm time** for training days, write out your anchor chain, and print this week's sheet.
- [ ] Write **3–5 implementation intentions** and **3 if–then plans**, including one for the day you feel strong enough to do more, and put them on your phone's lock screen.
- [ ] Each evening, lay out your kit and pack the bag (3 kg or less, on your uninjured shoulder).
- [ ] Put a **10-minute weekly review** in your calendar for Sunday, and plan your training around the **next public holiday or trip**.
- [ ] Save your GP's number and **Samaritans (116 123)** in your phone, just in case, and ask a friend to join one Saturday walk.

## Sources

- James Clear. [How long does it actually take to form a new habit?](https://jamesclear.com/new-habit) (summarising Lally et al., UCL), [Identity-based habits](https://jamesclear.com/identity-based-habits), [Implementation intentions](https://jamesclear.com/implementation-intentions), [Never miss twice / the second mistake](https://jamesclear.com/second-mistake).
- BJ Fogg. [Tiny Habits](https://tinyhabits.com/).
- Singh B, et al. Time to form a habit: a systematic review and meta-analysis. *Healthcare (Basel)* 2024;12:2488. Divine A, Astill S. Reinforcing implementation intentions with imagery. *Br J Health Psychol* 2025. [Europe PMC records](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=%22time%20to%20form%20a%20habit%22%20AND%20meta-analysis&format=json&resultType=core&pageSize=3).
- Teixeira PJ, et al. Exercise, physical activity, and self-determination theory: a systematic review. *Int J Behav Nutr Phys Act* 2012;9:78. [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22exercise%2C%20physical%20activity%2C%20and%20self-determination%20theory%22&format=json&resultType=core&pageSize=2).
- Milne S, Orbell S, Sheeran P. Combining motivational and volitional interventions to promote exercise participation. *Br J Health Psychol* 2002;7:163–84. [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=AUTH%3A%22Milne%20S%22%20AND%20%22implementation%20intentions%22%20AND%20exercise&format=json&resultType=core&pageSize=3).
- Silva MAVD, et al. Impact of implementation intentions on physical activity practice in adults: a systematic review and meta-analysis. *PLoS One* 2018;13:e0206294. [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22implementation%20intentions%20on%20physical%20activity%22&format=json&resultType=core&pageSize=3).
- Michie S, et al. Effective techniques in healthy eating and physical activity interventions: a meta-regression. *Health Psychol* 2009;28:690–701. [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22effective%20techniques%20in%20healthy%20eating%20and%20physical%20activity%20interventions%22&format=json&resultType=core&pageSize=2).
- Epton T, et al. Unique effects of setting goals on behavior change. *J Consult Clin Psychol* 2017;85:1182–98. [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22unique%20effects%20of%20setting%20goals%20on%20behavior%20change%22&format=json&resultType=core&pageSize=2).
- Truong LK, et al. Psychological, social and contextual factors across recovery stages following a sport-related knee injury. *Br J Sports Med* 2020. McCullough KA, et al. Return to high school- and college-level football after ACL reconstruction. *Am J Sports Med* 2012. [Europe PMC records](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID%3A22922520%20OR%20EXT_ID%3A32060141&format=json&resultType=lite).
- Magnus CR, et al. Cross-education for improving strength and mobility after distal radius fractures: a randomized controlled trial. *Arch Phys Med Rehabil* 2013;94:1247–55. Liguori S, et al. Overview of Cochrane systematic reviews for rehabilitation in upper limb fractures. *Medicina* 2024;60:469. [Europe PMC records](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=%22cross-education%22%20AND%20%22distal%20radius%20fracture%22&format=json&resultType=core&pageSize=4).
- Noetel M, et al. Effect of exercise for depression: systematic review and network meta-analysis. *BMJ* 2024;384:e075847. [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22exercise%20for%20depression%22%20AND%20%22network%20meta-analysis%22%20AND%20AUTH%3A%22Noetel%22&format=json&resultType=core&pageSize=3).
- Singh B, et al. Effectiveness of physical activity interventions for improving depression, anxiety and distress: an overview of systematic reviews. *Br J Sports Med* 2023;57:1203–9. [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22physical%20activity%20interventions%20for%20improving%20depression%2C%20anxiety%20and%20distress%22&format=json&resultType=core&pageSize=2).
- NHS. [NHS Talking Therapies](https://www.nhs.uk/mental-health/talking-therapies-medicine-treatments/talking-therapies-and-counselling/nhs-talking-therapies/). Samaritans. [Contact a Samaritan](https://www.samaritans.org/how-we-can-help/contact-samaritan/).
- Kellmann M, et al. Recovery and performance in sport: consensus statement. *Int J Sports Physiol Perform* 2018;13:240–5. [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22recovery%20and%20performance%20in%20sport%22%20AND%20%22consensus%20statement%22&format=json&resultType=core&pageSize=2).
- Stults-Kolehmainen MA, Sinha R. The effects of stress on physical activity and exercise. *Sports Med* 2014;44:81–121. [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22effects%20of%20stress%20on%20physical%20activity%20and%20exercise%22&format=json&resultType=core&pageSize=2).
- Stults-Kolehmainen MA, Bartholomew JB, Sinha R. Chronic psychological stress impairs recovery of muscular function and somatic sensations over a 96-hour period. *J Strength Cond Res* 2014;28:2007–17. [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22chronic%20psychological%20stress%20impairs%20recovery%20of%20muscular%20function%22&format=json&resultType=core&pageSize=2).
- Lindsay Smith G, et al. Social support and physical activity in older adults: a systematic review. *Int J Behav Nutr Phys Act* 2017. Van Luchene P, Delens C. Social support specific to physical activity among college and university students. *J Phys Act Health* 2021. [Europe PMC records](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID%3A28449673%20OR%20EXT_ID%3A33883289&format=json&resultType=lite).
- All Secure with Tom and Jen Satterly. [Pat McNamara](https://podcasts.apple.com/us/podcast/pat-mcnamara/id1648953982?i=1000586251661).
