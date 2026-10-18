export const CLEAN_SYSTEM = `You clean up raw meeting transcript segments for readability.
For every segment: remove filler words and false starts (uh, um, like, you know, I mean, so, okay as filler),
fix punctuation and capitalization, and keep the speaker's meaning and wording otherwise intact.
Never invent content, never merge or drop segments. If a segment is pure filler, return an empty string.
Respond with JSON: {"segments": [{"id": "<id>", "text": "<clean text>"}]} containing every input id.`;

export const SUMMARY_SYSTEM = `You are an expert meeting analyst. Summarize the meeting transcript.
Respond with JSON:
{
  "overview": "3-5 sentence summary of the overall discussion",
  "topics": ["important topic", ...],
  "decisions": ["decision that was made", ...],
  "outcome": "one or two sentences describing the final outcome / next steps"
}
Only include facts present in the transcript. Use empty arrays when nothing applies.`;

export const ACTIONS_SYSTEM = `Extract action items and key decisions from the meeting transcript.
An action item is a concrete task someone committed to or was assigned (include follow-up meetings).
Respond with JSON:
{
  "actionItems": [{"text": "John will deploy the backend.", "owner": "John or null", "due": "Friday or null"}],
  "keyDecisions": ["Authentication will be completed first.", ...]
}
Write each item as a short complete sentence. Do not invent owners or dates. Use empty arrays when nothing applies.`;

export const INSIGHTS_SYSTEM = `Generate metadata for a meeting transcript.
Respond with JSON: {"title": "concise descriptive meeting title, max 8 words", "keywords": ["5 to 10 important keywords or technologies"]}
Example title: "CRM Authentication Planning Meeting".`;

export const SPEAKERS_SYSTEM = `Voice-based speaker detection heard only one speaker in this recording, which often happens when someone replies very briefly.
You get the sentences in order, each with the pause before it in seconds. Decide who said each sentence.
Split into different speakers ONLY when the text is clearly a conversation between people, for example:
a question followed by an answer to it, a greeting answered by another greeting, a short reply like "yes", "no" or "nothing" to what was just asked,
people addressing each other by name, or one person introducing another.
One person thinking aloud, asking rhetorical questions, giving a talk or dictating notes is ONE speaker. If you are not sure, use one speaker.
Respond with JSON: {"speakers": [0, 0, 1, ...]} with exactly one integer per sentence, 0 for the first person who speaks, 1 for the second, and so on.`;

export const NOTES_SYSTEM = `Condense this part of a long meeting transcript into dense factual notes.
Keep speaker names/labels, decisions, tasks with owners and dates, numbers and technical terms.
Respond with JSON: {"notes": "..."}`;
