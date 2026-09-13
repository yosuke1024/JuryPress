/** Candidate only. Production stays on 4.8.x until the shadow review in #142 passes. */
export function discoursePromptApplies(version: string | undefined): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return !!match && (+match[1] > 4 || (+match[1] === 4 && +match[2] >= 9));
}

export const DISCOURSE_CRAFT = `
WRITING CRAFT — DEPTH AND DISCOURSE
- Uneven depth is allowed: spend words on the surprising mechanism or consequential concern; satisfy the schema without making every criterion or judge equally long.
- Do not narrate the outline or repeat announce → say → recap across standfirst, jury_summary, and final_verdict. Give each field a new role, not another version of the same thesis.
- Commit to the judgment the evidence supports and name the reversal condition where useful. Do not manufacture both-sides symmetry; leave an unanswered question open when evidence cannot settle it.
- Persona remains primary: preserve each juror's values and voice. Do not give everyone the same casual tone, inject typos, or force deliberate imperfection to produce variation.
`;
