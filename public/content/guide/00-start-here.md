# Start Here

> [!NOTE]
> **In short**
> - The hub is your coach, logbook and textbook in one place. It's written for an **experienced lifter returning after an injury layoff**: an arm fracture (for example a forearm fracture, possibly with surgical plates) that your fracture clinic hasn't fully cleared yet.
> - **Every morning:** check in → train → log. **Every Sunday:** weekly review. **Every 4 weeks:** retest. The plan moves forward on its own as you record each clearance your clinic gives you.
> - Until your fracture clinic clears you, your **injured arm does nothing**: no gripping, pushing, pulling, bracing, carrying or weight-bearing. A fall is the biggest risk to a healing bone.
> - You know how to train, so the main risks are your arm and doing too much too soon after the layoff. Let the arm set the pace.
> - Start with the **intake checklist** below. It's what a coach would ask you on day one, and it takes about 20 minutes.

## What this is

The programme serves five goals: **functional fitness**, long hikes on any terrain, a strong and stable core, the ability to carry heavy things like a farmer ("farmer strength"), and about **5 kg of extra muscle**. It assumes you trained regularly before the injury, know the lifts and gym etiquette, and have been out of training for a while. The job now is to get back to where you were and beyond, at the pace your arm allows. The hub turns all of that into a plan you can follow every day and track over time.

If you're new to lifting, every safety rule still applies, but get a coach for technique: this guide doesn't teach the basic lifts from scratch.

There are two halves:

- **The hub:** tells you what to do today, logs what you did, explains your numbers in plain English (coach notes) and shows your progress.
- **The guide:** 23 chapters on the why and the how, so you never have to guess.

## Your intake checklist

Fill this in yourself before your first week. Most answers go straight into the hub; the rest go in your notes or into your questions for the clinic. [Your Assessment & Goals](01-assessment-and-goals.md) explains what each answer changes.

| Area | What to record | Where it goes |
|---|---|---|
| Body | Sex (for the calorie formula), birth year, height, and this morning's weight | The welcome steps, then **Settings**. Your weight goes in each **Check-in** |
| Arm | Which arm is injured, and your dominant hand | The welcome steps, then **Settings** |
| Clearances | What your clinic or physio has cleared so far, and the date of each | **Your arm** (the welcome steps ask too) |
| Appointments | The date of your next fracture-clinic appointment, and whether you've been referred to physio | **Your arm** |
| Restrictions | Anything you've been told not to do, in the clinic's words, ideally in writing | Your notes, and **Your arm** after each appointment |
| Before the injury | Your usual body weight, your best recent lifts with their reps, how you trained, and your cardio and hiking background | Your usual weight in **Settings** ("Your usual weight before the injury"); the rest in your notes |
| Health | Other conditions, current medicines (painkillers and antibiotics included) and your PAR-Q+ result | Your notes |
| Start date | The Monday you start. If you don't pick one, the hub uses the next Monday | The welcome steps, then **Settings** |
| Time | Which days, what time of day and how long you can train. The plan assumes six sessions a week of 60–90 minutes, ideally first thing in the morning | Your notes |
| Gym | What your gym has and lacks, for example a sled belt, cable ankle straps, or the type of leg press | **Settings → My gym** |
| Food | How you eat and what you can spend. Halal-friendly and vegetarian swaps are built into the meal plans if you want them | **Settings → Diet notes** |
| Fasting | Any fasting you plan: for example Ramadan, another religious fast, or planned fasting | **Settings → Fasting periods** |
| Kit | A bathroom or smart scale, any wearable or chest strap, and a tape measure | Your morning **Check-in** |

## Where your numbers come from

The hub works out every target from your profile with standard formulas, and updates them as your weight changes. The guide shows the formulas worked through for one **example profile: a 30-year-old, 80 kg, 180 cm adult**. Your own numbers appear on **Nutrition** and **Settings**.

| | Formula | Example profile |
|---|---|---|
| Food | Mifflin–St Jeor BMR × activity factor (default 1.55), plus a 300 kcal surplus. Protein at 1.8 g/kg. Halal-friendly and vegetarian swaps, budget-first ([Nutrition](14-nutrition.md)) | About **3,060 kcal** (male) or **2,800 kcal** (female), and **144 g** of protein |
| Weight trend | Checked every 2 weeks against your band. It's faster while you regain to your pre-injury weight (add it in **Settings**) ([Nutrition](14-nutrition.md)) | +0.2–0.4 kg a week with no pre-injury weight set |
| Zone 2 | 60–70% of HRmax, with HRmax = 208 − 0.7 × age (Tanaka), or "can talk in full sentences" ([The Engine](10-engine-cardio.md)) | HRmax about **187**, Zone 2 about **112–131 bpm** |
| Muscle goal | Muscle you had before the injury comes back faster than new muscle grows | [Building Muscle](08-building-muscle.md) sets out the timeline |

## The daily routine

1. **Check-in (2 min).** Log your weight (after the toilet, before food), resting heart rate, sleep, energy, soreness, arm pain and the arm red-flag checklist. You get a readiness result:
   - **Green:** train as planned.
   - **Amber:** easy day. Halve the sets, Zone 2 only, no intervals, same loads. This is triggered by poor sleep, a raised resting HR, soreness, low energy, arm pain of 4/10 or more, rising arm pain, or a fasting day.
   - **Red:** a red flag is ticked, or your arm pain is 7/10 or more. **No training today, not even your physio exercises.** Contact your fracture clinic (or NHS 111 / 999 as the warning says). See [Your Arm](18-arm-recovery.md).
2. **Train.** Open **Today → Start**, or **Log a session**. Every exercise shows its sets, reps, rest, cues, what you did last time and the next step. Short on time? Use **"Short on time?"**. That still counts, and it keeps "never miss twice" alive.
3. **At the gym:** you have two options.
   - **On paper:** print the week (**Programme → Print this week**). The sheet shows last time's numbers and your targets. Write your sets on it, then type them in afterwards with **Log a session → Enter from sheet**.
   - **On your phone**, if the hub runs on a home server and you've switched on the optional phone access over Tailscale (the hosting guide in the `deploy/` folder explains it). You open the hub at your `https://<machine>.<tailnet>.ts.net` address and log as you go. Only the Tailscale logins you list can open it.
4. **Eat and recover:** hit your protein target, get to bed on time, and follow the carrying rule in [Your Arm](18-arm-recovery.md).

## The weekly and monthly rhythm

- **Sunday weekly review (10 min).** Open **Weekly review**. Write down one win, one struggle and one focus for next week, and tick off last week's focus.
- **Every 4 weeks:** retest on **Progress → Tests**, using the same conditions each time.
- **Every 2 weeks:** check your weight trend and adjust your food the way [Nutrition](14-nutrition.md) explains.

## How the plan unlocks (gates)

Your programme is split into phases. Some phases and exercises are locked behind **clearances**. You record a clearance on **Your arm**, using the date your clinic or physio gives you. Set a clearance only when a clinician has said so. [Your Arm](18-arm-recovery.md) has a table that turns each likely answer at your next fracture-clinic appointment into the right setting. [The Programme](04-the-program.md) explains what each clearance unlocks.

## Settings worth knowing on day one

- **Fasting periods.** If you'll fast, for example in Ramadan, during another religious fast or for planned fasting, add the dates under **Settings → Fasting periods**. The hub then switches to easy-day mode on those days. See [Nutrition](14-nutrition.md).
- **Changing how you measure resting HR.** If you switch method, for example from a wearable's overnight number to a manual pulse, or later to a chest strap, press **"I changed how I measure resting HR"** in Settings that morning, so readiness doesn't flag false amber days. See [Sleep & Recovery](17-sleep-and-recovery.md).
- **Your gym's kit.** Not every gym has a sled belt, cable ankle straps or a selectorised leg press, so the plan has substitutes, and a "dead start" method for a plate-loaded leg press. **Settings → My gym** keeps exercises your gym can't do out of swaps. It starts with the belt and ankle-strap exercises marked as not available: untick any your gym can do.

## Where the hub runs and how to get help

- **On your computer:** start it with `start_hub.bat` (Windows) or `start_hub.sh` (Linux or macOS). It opens at `http://127.0.0.1:8642` and is reachable only from that computer. The README has the details.
- **On a home server (optional):** the README and the hosting guide in the `deploy/` folder explain how to run it on a Linux server that you reach from your computer through an SSH tunnel, and how to add the optional phone access over Tailscale. Nothing becomes reachable from your home network or the internet.
- **Your data** is one file on the machine running the hub, with automatic daily backups. Export a copy any time with **Settings → Export as JSON**.
- **Reviews and updates:** to have a coach review your week or re-plan after a clinic visit, export your data and share the file. It's health data, so share it only with someone you trust. Updated content arrives as a new bundle (the README explains how to install one), and installing it never overwrites your data.

> [!SAFETY]
> This guide is coaching education, not medical advice. Your fracture clinic and physiotherapist come first. Get urgent help for any red-flag sign: pain getting worse, redness or heat around the scar or wound, discharge, fever or shivering, numbness, colour change, or a fall onto the arm. Dark (cola-coloured) urine with severe muscle pain after training also needs same-day medical advice.

## Your actions this week

- [ ] Fill in the **intake checklist**, finish the welcome steps, and check your profile in **Settings**
- [ ] Check in every morning, starting the day before your programme starts
- [ ] Do your **Re-entry Week** sessions: 2 easy sets plus one calibration set. Set up each machine one-handed, and print the week for the gym
- [ ] Read [Your Arm](18-arm-recovery.md) and prepare for your next fracture-clinic appointment (the top questions are on **Your arm**)
- [ ] Walk this weekend's suggested route (on **Hikes**), and do your first **Weekly review** on Sunday

## Sources

This chapter summarises the rest of the guide. Each chapter lists its own sources.
