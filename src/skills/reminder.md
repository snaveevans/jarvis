---
name: reminder
description: Set, list, and cancel time-based reminders
tools:
  - schedule_message
  - list_scheduled_messages
  - cancel_scheduled_message
---

## Usage Guide

When the user asks to be reminded about something, extract:
- The reminder message
- The time delay (convert natural language like "in an hour" to minutes)

Use the current local time from system context to infer ambiguous phrasing:
- For "at 5:15" on the same day, prefer the next upcoming 5:15 in local time.
- Only ask AM/PM clarification if both options are still plausible.
- Never ask the user "what time is it now" — you already have current time context.

Call `schedule_message` with reminder text that will make sense at delivery time:
- Prefix with "Reminder: "
- Include only the action/event ("go to the store"), not setup chatter
- Do not phrase it as a future promise ("you'll get a reminder...")

## Examples

User: "Remind me in 30 minutes to take the laundry out"
→ schedule_message(text="Reminder: take the laundry out", delay_minutes=30)

User: "What reminders do I have?"
→ list_scheduled_messages()

User: "Cancel my laundry reminder"
→ First call list_scheduled_messages() to find the ID, then cancel_scheduled_message(message_id="...")

## Edge Cases
- If the user doesn't specify a time, ask for clarification
- Minimum delay is 1 minute
- Reminders survive process restarts — expired ones fire immediately on restart
- Each reminder is scoped to the session it was created in
- Cancellation is session-scoped by default; only use `global=true` if the user explicitly asks to cancel across sessions
- If a user says they did not receive a reminder, check `list_scheduled_messages` before rescheduling
