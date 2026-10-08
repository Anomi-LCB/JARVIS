const actions = new Set(['read', 'list', 'save', 'send', 'delete', 'change', 'summarize', 'unsupported']);
export function validateAuthorCommand(command) {
  if (typeof command !== 'string' || command.length < 40 || command.length > 6000) throw Error('AUTHOR_COMMAND_INVALID');
  // Eligibility only. These checks are not a product parser or semantic gold adjudicator.
  if (!/(?:해\s*줘|해줘|주세요|하세요|십시오|세요|말아|말고|하지\s*마|읽어|찾아|저장해|보내|확인해|정리해)/u.test(command)) throw Error('AUTHOR_REQUEST_REQUIRED');
  if (!/(?:말아|말고|지\s*마|지\s*않|안\s*돼|안\s*되|금지)/u.test(command)) throw Error('AUTHOR_PROHIBITION_REQUIRED');
  return command;
}
export function validateAuthorAnnotation(command, requirements) {
  validateAuthorCommand(command);
  if (!Array.isArray(requirements) || requirements.length < 3 || requirements.length > 6) throw Error('AUTHOR_REQUIREMENTS_COUNT_INVALID');
  if (!requirements.some(r => r?.polarity === 'prohibited')) throw Error('AUTHOR_PROHIBITED_ANNOTATION_REQUIRED');
  let end = 0;
  return requirements.map(r => {
    if (!r || typeof r.text !== 'string' || !r.text.trim() || !actions.has(r.action)
      || !['required', 'prohibited'].includes(r.polarity) || typeof r.target !== 'string') throw Error('AUTHOR_ANNOTATION_INVALID');
    const start = command.indexOf(r.text, end);
    if (start < end) throw Error('AUTHOR_SOURCE_SPAN_INVALID');
    if (r.target && !r.text.includes(r.target)) throw Error('AUTHOR_INFERRED_TARGET_INVALID');
    // Flag clear contradictions for a new annotation, never silently relabel gold.
    if (r.action === 'delete' && /저장(?:하지|은\s*하지|을\s*하지)/u.test(r.text)) throw Error('AUTHOR_SAVE_PROHIBITION_LABELLED_DELETE');
    if (r.action === 'delete' && /닫(?:아|으|고|기)/u.test(r.text)) throw Error('AUTHOR_CLOSE_LABELLED_DELETE');
    end = start + r.text.length;
    return { ...r, sourceSpan: { start, end } };
  });
}
