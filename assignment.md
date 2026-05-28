Technical Assignment — 
Estimated Time: 6–8 hours
 Submission: Share a GitHub repository with a README explaining how to run each part, along with a screen recording of you working through the assignment end to end.

Overview
This assignment reflects the real shape of our product. You will build a full-stack agentic chat system — a streaming backend, a live chat UI that renders AI responses as they arrive, and a voice layer on top. The goal is not to see if you can copy-paste from a tutorial, but to see how you design a system under real-world constraints.
Use TypeScript and Bun for the backend. Use React for the frontend. Library and framework choices within those are yours to make — pick what you know and be ready to explain why.
You are free to use AI coding tools (Cursor, Copilot, etc.), but be prepared to walk us through your decisions in the follow-up call.

Screen Recording Requirement
Record your entire working session from start to finish. The recording should show:
Your terminal, editor, and browser as you build and test each part
How you approach problems when something doesn't work as expected
The final product running end to end — backend, UI, and voice all working together
You must narrate throughout. This is not optional. We want to hear your thinking as you work — not a polished presentation after the fact, but your real-time reasoning as you build.
Specifically:
When AI writes code for you, stop and explain it. Walk through what the code does, why it works, and whether you would have written it differently yourself. Do not accept and move on silently.
When you make a design decision, say why — why this approach, what you considered and ruled out.
When something breaks, talk through how you are diagnosing it before you fix it.
The entire assignment must be completed in a single uninterrupted session. No editing together multiple recordings, no cutting between days. The recording must run continuously from a blank project to a working submission. If you need a break, pause the timer — but the recording must reflect one continuous session with a visible, unbroken timeline.
We are evaluating whether you understand what you are building, not just whether it works. A candidate who can ship with AI assistance and explain every line of output is exactly who we are looking for. A candidate who cannot explain code they just accepted is not.
Tools like Loom, OBS, or any screen recorder are fine. Upload the recording and include the link in your README.

Part 1 — Agentic Streaming Backend (TypeScript + Bun)
Context: Our backend serves an AI agent that can call tools, reason across multiple steps, and stream its response back to the browser in real time.
What to Build
A streaming chat endpoint that accepts a message and conversation identifier. The response must stream back to the client incrementally — the frontend should receive text as it is generated, not after the full response is ready. The stream must carry enough structure for the frontend to distinguish between response text, tool activity, and completion metadata.
A multi-step tool-calling agent. The agent should support at least two tools relevant to a healthcare information use case. It must be able to call a tool, receive the result, and continue reasoning before generating a final response — automatically, without the client prompting it again. Cap execution at a maximum number of steps.
Conversation persistence. Load prior messages before each request and save the full updated history after each response. Design your own schema.
Usage tracking. After each response, persist token counts, latency, and estimated cost somewhere retrievable.
Resilience. Validate all inputs. Return structured errors. If the AI call fails or times out, respond gracefully — do not crash.

Part 2 — Streaming Chat UI (React)
Context: Our chat frontend renders AI responses in real time. Tool calls are visible to the user. Reasoning steps can be expanded. Each message carries metadata about how it was generated.
What to Build
A React chat page connected to your Part 1 backend. It must:
Stream and render responses token by token. The user sees text appearing as it is generated — not a blank screen followed by a complete answer.
Render markdown — headings, lists, code blocks, tables, bold, italic. Pick a rendering library you are comfortable with.
Show tool calls inline within the message where they occurred. Each tool call should show the tool name, its input, and its output. The state — pending, running, complete — should be visually distinct.
Show a reasoning panel if the agent emits thinking/reasoning content. It should be collapsible and visually indicate when it is actively streaming.
Show per-message metadata below each assistant message — timestamp, model name, token counts, and cost if available.
Show a loading indicator while waiting for the first token after the user submits.
Allow message deletion. Each message should have a delete action that removes it and updates the conversation.
Load conversation history on page load and hydrate the chat state before rendering.
The UI should feel polished — not a tutorial clone. Clear visual hierarchy, readable typography, proper spacing between user and assistant messages.

Part 3 — Voice Integration
Context: Our product supports voice input and voice output. Both must be wired into the same chat interface.
Voice Input (Speech → Text)
Add a microphone button to the chat input. When pressed, begin capturing audio from the user's microphone.
As the user speaks, the text input should update in real time with what is being said. Once the user finishes speaking, the message should be submitted to the agent automatically after a short pause.
Handle microphone permission errors with a clear user-facing message.
Voice Output (Text → Speech)
Add a toggle that enables or disables audio playback of assistant responses.
When enabled, after each assistant message finishes streaming, generate audio for it via a backend endpoint that calls a TTS provider of your choice.
Auto-play the audio for the most recent assistant message. Older messages should show a manual player with play, pause, seek, and volume controls.
If TTS generation fails, fail silently — do not interrupt the chat experience.

Part 4 — DevOps & Infrastructure
What to Build
A docker-compose.yml that brings up your backend and all required services with a single command. Services should only start once their dependencies are healthy.
A Dockerfile for your backend — minimal image, production dependencies only, non-root user.
An automated migration step that runs before the backend accepts traffic. Document this in your README.
An .env.example that documents every required environment variable — which are required, which have safe defaults, which are secrets.
Bonus — CI/CD. A GitHub Actions workflow that builds the image, spins up the stack, waits for a health check, and runs your tests. Fails fast on any non-zero exit.

Evaluation Criteria
Area
What We Look For
Agentic Design
Does the agent reason across multiple steps and handle tool results correctly?
Streaming
Does the UI actually render tokens as they arrive?
Tool Rendering
Are tool calls visible and readable during and after execution?
Voice
Does mic input flow into the chat? Does audio playback work correctly?
Resilience
What happens when the AI times out? When mic is denied? When audio generation fails?
DevOps
Does docker compose up work first try?
Recording
Can we follow your thought process and see the full product working?


Submission Checklist
GitHub repository with a clear README
Screen recording link included in the README
docker compose up brings up the full stack in one command
.env.example present, no real secrets committed
All three product parts completed — backend, UI, and voice
Part 4 DevOps completed — it is not optional
Brief notes on library choices and any tradeoffs made

