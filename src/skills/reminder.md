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

Call `schedule_message` with the reminder text and delay. Prefix the text
with "Reminder: " so the user knows it's a reminder when it arrives.

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
